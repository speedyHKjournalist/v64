//! Runs of register-only x87 forms (FLD ST(i)/FLD1/FLDZ, arithmetic on
//! ST(i), FXCH, FST(P) ST(i), FCHS/FABS, FFREE) with their stack positions
//! known relative to the TOP at the run's start: one guard checks that every
//! slot read holds an exact cached f64 and every slot pushed is empty, then
//! the run computes in f64 locals and commits once. The results are exactly
//! those of the per-form native path (backend::wasm::x87), which runs the
//! instructions one by one when the guard fails.
use super::{Instruction, Page};
use crate::cpu::{fpu, global_pointers as gp};
use crate::ir::x87::{Arithmetic, Io, Native, Source};
use crate::wasmgen::wasm_builder::{Label, WasmLocalF64};

const C1: i32 = 0x200;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Unknown,
    Full,
    Empty,
}
#[derive(Clone, Copy)]
enum Value {
    /// Loaded at the run's start from the slot `k` (relative to entry TOP).
    Entry(u8),
    Constant(bool),
    /// The result of step `n`.
    Step(usize),
}
#[derive(Clone, Copy)]
enum Step {
    Arithmetic(Arithmetic, Value, Value),
    Unary(bool, Value),
}

/// Compile-time stack of one run, positions relative to the entry TOP.
#[derive(Clone)]
pub(super) struct Plan {
    /// Current TOP relative to the entry TOP.
    top: u8,
    tags: [Tag; 8],
    values: [Option<Value>; 8],
    steps: Vec<Step>,
    need_full: u8,
    need_empty: u8,
    written: u8,
    pushed: bool,
    pub length: usize,
}
impl Plan {
    pub fn new() -> Self {
        Plan {
            top: 0,
            tags: [Tag::Unknown; 8],
            values: [None; 8],
            steps: vec![],
            need_full: 0,
            need_empty: 0,
            written: 0,
            pushed: false,
            length: 0,
        }
    }
    fn rel(&self, r: u8) -> usize { (self.top + r) as usize & 7 }
    fn read(&mut self, r: u8) -> Option<Value> {
        let k = self.rel(r);
        match self.tags[k] {
            Tag::Empty => None,
            Tag::Full => Some(self.values[k].unwrap_or(Value::Entry(k as u8))),
            Tag::Unknown => {
                self.need_full |= 1 << k;
                self.tags[k] = Tag::Full;
                self.values[k] = Some(Value::Entry(k as u8));
                self.values[k]
            },
        }
    }
    fn write(&mut self, r: u8, value: Value) {
        let k = self.rel(r);
        self.values[k] = Some(value);
        self.written |= 1 << k;
    }
    fn pop(&mut self) {
        let k = self.rel(0);
        self.tags[k] = Tag::Empty;
        self.top = (self.top + 1) & 7;
    }
    /// Add one form; false (plan unchanged) if it cannot join the run.
    pub fn append(&mut self, i: &Instruction) -> bool {
        let d = &i.decoded;
        let (opcode, Some(modrm)) = (d.encoding.opcode, d.modrm)
        else {
            return false;
        };
        if !(0xD8..=0xDF).contains(&opcode)
            || d.ea.is_some()
            || crate::ir::x87::io(opcode as u8, modrm) != Some(Io::Stack)
        {
            return false;
        }
        let Some(native) = crate::ir::x87::native(opcode as u8, modrm)
        else {
            return false;
        };
        let mut next = self.clone();
        let ok = (|| {
            match native {
                Native::Push(source) => {
                    let value = match source {
                        Source::Register(r) => next.read(r)?,
                        Source::Constant(one) => Value::Constant(one),
                        Source::Memory(_) => return None,
                    };
                    let k = next.rel(7);
                    match next.tags[k] {
                        Tag::Full => return None,
                        Tag::Unknown => next.need_empty |= 1 << k,
                        Tag::Empty => {},
                    }
                    next.tags[k] = Tag::Full;
                    next.top = k as u8;
                    next.write(0, value);
                    next.pushed = true;
                },
                Native::Arithmetic { op, source: Source::Register(r), target, pops } => {
                    let x = next.read(0)?;
                    let y = next.read(r)?;
                    next.steps.push(Step::Arithmetic(op, x, y));
                    next.write(target, Value::Step(next.steps.len() - 1));
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                Native::Exchange(r) => {
                    let a = next.read(0)?;
                    let b = next.read(r)?;
                    next.write(0, b);
                    next.write(r, a);
                },
                Native::Copy { r, pops } => {
                    let value = next.read(0)?;
                    let k = next.rel(r);
                    next.tags[k] = Tag::Full;
                    next.write(r, value);
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                Native::Unary { negate } => {
                    let value = next.read(0)?;
                    next.steps.push(Step::Unary(negate, value));
                    next.write(0, Value::Step(next.steps.len() - 1));
                },
                Native::Free { r, pops } => {
                    let k = next.rel(r);
                    next.tags[k] = Tag::Empty;
                    for _ in 0..pops {
                        next.pop();
                    }
                },
                _ => return None,
            }
            Some(())
        })();
        if ok.is_none() {
            return false;
        }
        next.length += 1;
        *self = next;
        true
    }
}

impl Page {
    /// Emit the run's fast path: to `slow` unless the guard holds, else the
    /// run's effect on the (open) x87 cache and the f64 shadow values.
    pub(super) fn x87_run(&mut self, plan: &Plan, slow: Label) {
        let [values, _, _] = fpu::x87_cache_addresses();
        let c = self.x87.unsafe_clone();
        // #NM/#UD and the native policy: the per-form path decides.
        self.w.load_fixed_i32(gp::cr as u32);
        self.w.const_i32(crate::cpu::cpu::CR0_EM | crate::cpu::cpu::CR0_TS);
        self.w.and_i32();
        self.w.hint(false);
        self.w.br_if(slow);
        self.w.load_fixed_u8(gp::x87_native_policy as u32);
        self.w.eqz_i32();
        self.w.hint(false);
        self.w.br_if(slow);
        // Masks relative to TOP: rotate right by TOP (8 bits).
        let rotate = |p: &mut Page, mask: &dyn Fn(&mut Page)| {
            mask(p);
            p.w.get_local(&c.top);
            p.w.shr_u_i32();
            mask(p);
            p.w.const_i32(8);
            p.w.get_local(&c.top);
            p.w.sub_i32();
            p.w.shl_i32();
            p.w.or_i32();
            p.w.const_i32(255);
            p.w.and_i32();
        };
        if plan.need_full != 0 {
            // Every slot read: nonempty and an exact cached value.
            rotate(self, &|p: &mut Page| {
                p.w.get_local(&c.valid);
                p.w.const_i32(-1);
                p.w.xor_i32();
                p.w.get_local(&c.tags);
                p.w.or_i32();
                p.w.const_i32(255);
                p.w.and_i32();
            });
            self.w.const_i32(plan.need_full as i32);
            self.w.and_i32();
            self.w.hint(false);
            self.w.br_if(slow);
        }
        if plan.need_empty != 0 {
            rotate(self, &|p: &mut Page| p.w.get_local(&c.tags));
            self.w.const_i32(plan.need_empty as i32);
            self.w.and_i32();
            self.w.const_i32(plan.need_empty as i32);
            self.w.ne_i32();
            self.w.hint(false);
            self.w.br_if(slow);
        }
        let slot = |p: &mut Page, k: u8| {
            p.w.get_local(&c.top);
            p.w.const_i32(k as i32);
            p.w.add_i32();
            p.w.const_i32(7);
            p.w.and_i32();
        };
        let mut entry: [Option<WasmLocalF64>; 8] = Default::default();
        for k in 0..8u8 {
            if plan.need_full & 1 << k != 0 {
                slot(self, k);
                self.w.const_i32(3);
                self.w.shl_i32();
                self.w.load_aligned_f64(values);
                entry[k as usize] = Some(self.w.set_new_local_f64());
            }
        }
        let mut results: Vec<WasmLocalF64> = vec![];
        let push = |p: &mut Page, v: Value, results: &[WasmLocalF64], entry: &[Option<WasmLocalF64>; 8]| match v {
            Value::Entry(k) => p.w.get_local_f64(entry[k as usize].as_ref().unwrap()),
            Value::Constant(one) => p.w.const_f64(if one { 1.0 } else { 0.0 }),
            Value::Step(n) => p.w.get_local_f64(&results[n]),
        };
        for step in &plan.steps {
            match *step {
                Step::Arithmetic(op, x, y) => {
                    let (a, b) = match op {
                        Arithmetic::SubR | Arithmetic::DivR => (y, x),
                        _ => (x, y),
                    };
                    push(self, a, &results, &entry);
                    push(self, b, &results, &entry);
                    self.w.arithmetic_f64(match op {
                        Arithmetic::Add => 0,
                        Arithmetic::Sub | Arithmetic::SubR => 1,
                        Arithmetic::Mul => 2,
                        Arithmetic::Div | Arithmetic::DivR => 3,
                    });
                },
                Step::Unary(negate, v) => {
                    push(self, v, &results, &entry);
                    self.w.unary_f64(negate);
                },
            }
            results.push(self.w.set_new_local_f64());
        }
        // Commit: values of written slots (VALID|DIRTY), tags, TOP, C1.
        for k in 0..8u8 {
            if plan.written & 1 << k == 0 {
                continue;
            }
            slot(self, k);
            self.w.const_i32(3);
            self.w.shl_i32();
            push(self, plan.values[k as usize].unwrap(), &results, &entry);
            self.w.store_aligned_f64(values);
        }
        let mut full = 0u8;
        let mut empty = 0u8;
        for k in 0..8 {
            match plan.tags[k] {
                // Pushed/copied slots were set full; read slots stay full.
                Tag::Full if plan.written & 1 << k != 0 || plan.need_empty & 1 << k != 0 => full |= 1 << k,
                Tag::Empty => empty |= 1 << k,
                _ => {},
            }
        }
        // Rotate compile-time relative masks left by TOP into physical bits.
        let physical = |p: &mut Page, mask: u8| {
            p.w.const_i32(mask as i32);
            p.w.get_local(&c.top);
            p.w.shl_i32();
            p.w.const_i32(mask as i32);
            p.w.const_i32(8);
            p.w.get_local(&c.top);
            p.w.sub_i32();
            p.w.shr_u_i32();
            p.w.or_i32();
            p.w.const_i32(255);
            p.w.and_i32();
        };
        if plan.written != 0 {
            for local in [&c.valid, &c.dirty] {
                self.w.get_local(local);
                physical(self, plan.written);
                self.w.or_i32();
                self.w.set_local(local);
            }
        }
        if full != 0 || empty != 0 {
            self.w.get_local(&c.tags);
            physical(self, empty);
            self.w.or_i32();
            physical(self, full);
            self.w.const_i32(-1);
            self.w.xor_i32();
            self.w.and_i32();
            self.w.set_local(&c.tags);
        }
        if plan.top != 0 {
            self.w.get_local(&c.top);
            self.w.const_i32(plan.top as i32);
            self.w.add_i32();
            self.w.const_i32(7);
            self.w.and_i32();
            self.w.set_local(&c.top);
        }
        if plan.pushed {
            self.w.const_i32(gp::fpu_status_word as i32);
            self.w.load_fixed_u16(gp::fpu_status_word as u32);
            self.w.const_i32(!C1);
            self.w.and_i32();
            self.w.store_aligned_u16(0);
        }
        for local in entry.into_iter().flatten().chain(results) {
            self.w.free_local_f64(local);
        }
    }
}
