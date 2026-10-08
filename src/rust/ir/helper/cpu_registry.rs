//! Registry for CPU CallHelper adapters used by the byte frontend.
//! Signatures are independent of HIR call-site inference. Effects remain fully
//! conservative until a narrower, independently audited contract is registered.
use super::{ExceptionOwner, HelperAbi, HelperDescriptor};
use crate::ir::{effects::Effects, types::Type};

pub fn arity(name: &str) -> Option<usize> {
    Some(match name {
        "ir_sti_check"
        | "ir_cli_check"
        | "ir_fwait"
        | "ir_cli"
        | "ir_clts"
        | "ir_cpuid"
        | "ir_cpuid_continue"
        | "ir_far_control_ud"
        | "ir_flags_stack_check"
        | "ir_hlt"
        | "ir_rdmsr"
        | "ir_rdtsc"
        | "ir_rdtsc_continue"
        | "ir_sysenter"
        | "ir_sysexit"
        | "ir_wbinvd"
        | "ir_wrmsr" => 0,
        "ir_sti_finish_continue"
        | "ir_iret"
        | "ir_verr_mem"
        | "ir_verr_reg"
        | "ir_verw_mem"
        | "ir_verw_reg" => 1,
        "ir_arpl_reg"
        | "ir_rdrand"
        | "ir_descriptor_ud"
        | "ir_far_return"
        | "ir_fxrstor"
        | "ir_fxsave"
        | "ir_in"
        | "ir_in_continue"
        | "ir_invlpg"
        | "ir_io_check"
        | "ir_mov_segment_continue"
        | "ir_ldmxcsr"
        | "ir_lgdt"
        | "ir_lidt"
        | "ir_lldt_mem"
        | "ir_lldt_reg"
        | "ir_lmsw_mem"
        | "ir_lmsw_reg"
        | "ir_ltr_mem"
        | "ir_ltr_reg"
        | "ir_pop_flags"
        | "ir_rdtscp"
        | "ir_read_cr"
        | "ir_read_cr_continue"
        | "ir_read_dr"
        | "ir_read_dr_continue"
        | "ir_sgdt"
        | "ir_sidt"
        | "ir_sldt_mem"
        | "ir_sldt_reg"
        | "ir_smsw_mem"
        | "ir_smsw_reg"
        | "ir_software_interrupt"
        | "ir_stmxcsr"
        | "ir_str_mem"
        | "ir_str_reg"
        | "ir_write_cr"
        | "ir_write_dr"
        | "ir_xgetbv_xsetbv"
        | "ir_xrstor"
        | "ir_xrstors"
        | "ir_xsave"
        | "ir_xsavec"
        | "ir_xsaveopt"
        | "ir_xsaves" => 2,
        "ir_invalid_form"
        | "ir_arpl_mem"
        | "ir_movnti"
        | "ir_far_jump_mem"
        | "ir_lar_mem"
        | "ir_lar_reg"
        | "ir_lsl_mem"
        | "ir_lsl_reg"
        | "ir_out"
        | "ir_out_continue"
        | "ir_pop_segment"
        | "ir_ins_once"
        | "ir_outs_once"
        | "ir_crc32_reg_continue" => 3,
        "ir_reserved_form"
        | "ir_mmx_mask"
        | "ir_mmx_reg"
        | "ir_mmx_reg_continue"
        | "ir_mmx_xmm_continue"
        | "ir_sse_fp_reg_continue"
        | "ir_sse_fp_reg"
        | "ir_far_jump"
        | "ir_ins"
        | "ir_outs"
        | "ir_x87_reg_continue"
        | "ir_x87_reg"
        | "ir_crc32_mem_continue"
        | "ir_avx_continue" => 4,
        "ir_mmx_mem"
        | "ir_sse_fp_mem_continue"
        | "ir_sse_fp_mem"
        | "ir_load_segment"
        | "ir_rep_cmps"
        | "ir_rep_ins"
        | "ir_rep_lods"
        | "ir_rep_movs"
        | "ir_rep_outs"
        | "ir_rep_scas"
        | "ir_rep_stos"
        | "ir_x87_mem"
        | "ir_avx_fp_reg_continue" => 5,
        _ => return None,
    })
}
fn abi(name: &str) -> HelperAbi {
    if scalar_reload(name)
        || matches!(
            name,
            "ir_mmx_xmm_continue"
                | "ir_sse_fp_reg_continue"
                | "ir_sse_fp_mem_continue"
                | "ir_crc32_mem_continue"
                | "ir_avx_continue"
                | "ir_avx_fp_reg_continue"
        )
    {
        HelperAbi::CpuReload
    }
    else if name.starts_with("ir_rep_") {
        HelperAbi::CpuRep
    }
    else if matches!(
        name,
        "ir_sti_finish_continue"
            | "ir_sti_check"
            | "ir_cli_check"
            | "ir_flags_stack_check"
            | "ir_io_check"
            | "ir_mov_segment_continue"
    ) {
        HelperAbi::Outcome {
            fault_delivery: None,
            normal_preserves_state: true,
        }
    }
    else {
        HelperAbi::CpuExit
    }
}
pub fn descriptor(name: &str, params: Vec<Type>) -> Result<HelperDescriptor, &'static str> {
    if arity(name).is_none() {
        return Err("unregistered CPU call helper");
    }
    let descriptor = HelperDescriptor {
        name: name.into(),
        params,
        results: if matches!(abi(name), HelperAbi::CpuReload) {
            reload_types(name)
        }
        else {
            vec![]
        },
        effects: Effects::conservative(),
        exception_owner: ExceptionOwner::Helper,
        abi: abi(name),
    };
    validate(&descriptor)?;
    Ok(descriptor)
}
pub fn validate(d: &HelperDescriptor) -> Result<(), &'static str> {
    let Some(count) = arity(&d.name)
    else {
        return Ok(());
    };
    if d.params.len() != count
        || d.results
            != if matches!(abi(&d.name), HelperAbi::CpuReload) {
                reload_types(&d.name)
            }
            else {
                vec![]
            }
        || d.params.iter().any(|t| {
            !matches!(
                t,
                Type::I1
                    | Type::I8
                    | Type::I16
                    | Type::I32
                    | Type::EffectiveAddress
                    | Type::LinearAddress
                    | Type::RamAddress
            )
        })
    {
        return Err("CPU call helper signature mismatch");
    }
    let matching_abi = match (abi(&d.name), &d.abi) {
        (HelperAbi::CpuReload, HelperAbi::CpuReload) => true,
        (HelperAbi::CpuExit, HelperAbi::CpuExit) | (HelperAbi::CpuRep, HelperAbi::CpuRep) => true,
        (
            HelperAbi::Outcome { .. },
            HelperAbi::Outcome {
                fault_delivery: None,
                normal_preserves_state: true,
            },
        ) => true,
        _ => false,
    };
    if !matching_abi
        || d.exception_owner != ExceptionOwner::Helper
        || d.effects != Effects::conservative()
    {
        return Err("CPU call helper observation/outcome contract mismatch");
    }
    Ok(())
}

/// Audited register-only SSE arithmetic/conversion forms. They read only the
/// two XMM operands and MXCSR/x87 backing, modify only the destination XMM,
/// MXCSR's flags and FP backing, and cannot call host observers or fault after
/// the CR0 task guard succeeds unless MXCSR unmasks an exception (the backend's
/// sse_task_observation takes the full-state path for both). Integer/FLAGS
/// conversions and every memory form retain the full contract. The SSSE3 and
/// listed SSE4 XMM forms read and write only the XMM operands.
pub fn xmm_register_operands(
    region: &crate::ir::hir::Region,
    args: &[crate::ir::ids::ValueId],
) -> Option<(u8, u8)> {
    use crate::ir::hir::{Definition, Op};
    let constant = |n: usize| {
        let Definition::Instruction(id, 0) = region.values.get(args.get(n)?.index())?.definition
        else {
            return None;
        };
        if let Op::Const(v) = region.instructions[id.index()].op {
            u32::try_from(v).ok()
        }
        else {
            None
        }
    };
    // (ir_avx_fp_reg_continue: the VEX forms of the same keys)
    if !xmm_register_op(constant(0)?) {
        return None;
    }
    let source = constant(1)?;
    let destination = constant(2)?;
    if source >= 8 || destination >= 8 {
        return None;
    }
    Some((source as u8, destination as u8))
}
/// The keys of xmm_register_operands
pub fn xmm_register_op(op: u32) -> bool {
    matches!(
        op,
        0x0F51
            | 0x0F52
            | 0x0F53
            | 0x0F58
            | 0x0F59
            | 0x0F5A
            | 0x0F5B
            | 0x0F5C
            | 0x0F5D
            | 0x0F5E
            | 0x0F5F
            | 0x0FC2
            | 0x660F51
            | 0x660F58
            | 0x660F59
            | 0x660F5A
            | 0x660F5B
            | 0x660F5C
            | 0x660F5D
            | 0x660F5E
            | 0x660F5F
            | 0x660F7C
            | 0x660F7D
            | 0x660FC2
            | 0x660FD0
            | 0x660FE6
            | 0xF20F51
            | 0xF20F58
            | 0xF20F59
            | 0xF20F5A
            | 0xF20F5C
            | 0xF20F5D
            | 0xF20F5E
            | 0xF20F5F
            | 0xF20F7C
            | 0xF20F7D
            | 0xF20FC2
            | 0xF20FD0
            | 0xF20FE6
            | 0xF30F51
            | 0xF30F52
            | 0xF30F53
            | 0xF30F58
            | 0xF30F59
            | 0xF30F5A
            | 0xF30F5B
            | 0xF30F5C
            | 0xF30F5D
            | 0xF30F5E
            | 0xF30F5F
            | 0xF30FC2
            | 0xF30FE6
            | 0x660F3800..=0x660F380B
            | 0x660F381C..=0x660F381E
            | 0x660F3A0F
            // SSE4.1/SSE4.2 between two XMM registers (not BLENDV: XMM0;
            // PTEST: FLAGS; PEXTR*/PINSR*: a GPR; the PackedOp and ShuffleOp
            // forms are native)
            | 0x660F3820..=0x660F3825
            | 0x660F3828
            | 0x660F3830..=0x660F3835
            | 0x660F3841
            | 0x660F3A08..=0x660F3A0B
            | 0x660F3A21
            | 0x660F3A40..=0x660F3A42
    )
}

/// Successful forms have no guest-memory/host observation or mapping writes.
/// Fault outcomes still exit through full exception recovery and revoke reuse.
pub fn preserves_code_on_success(name: &str) -> bool {
    matches!(
        name,
        "ir_cli"
            | "ir_cli_check"
            | "ir_clts"
            | "ir_cpuid"
            | "ir_cpuid_continue"
            | "ir_read_cr"
            | "ir_read_cr_continue"
            | "ir_read_dr"
            | "ir_read_dr_continue"
            | "ir_mmx_reg_continue"
            | "ir_mmx_xmm_continue"
            | "ir_x87_reg_continue"
            | "ir_crc32_reg_continue"
    )
}

/// These adapters verify all captured code/mappings and control context after
/// any host observation, preserving XMMs or declining Normal altogether.
pub fn checked_scalar_continuation(name: &str) -> bool {
    matches!(
        name,
        "ir_in_continue" | "ir_out_continue" | "ir_rdtsc_continue"
    )
}
pub fn reload_types(name: &str) -> Vec<Type> {
    if scalar_reload(name) {
        vec![Type::I32; 14]
    }
    else {
        super::cpu_reload_types()
    }
}

/// Register helpers preserve XMMs without observers or memory access on Normal.
/// Keep this separate from checked observers: only those must refresh the
/// admission epoch after revalidating an active code owner.
fn scalar_reload(name: &str) -> bool {
    checked_scalar_continuation(name)
        || matches!(
            name,
            "ir_x87_reg_continue"
                | "ir_mmx_reg_continue"
                | "ir_crc32_reg_continue"
                | "ir_read_cr_continue"
                | "ir_read_dr_continue"
                | "ir_cpuid_continue"
        )
}
