// TSS/header and I/O-bitmap reads can observe the host before the port itself.
// Their mutations must invalidate SSA continuation without replaying the port.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PC = 0x100000, ALT = 0x110000, TSS = 0x40000, BITMAP = TSS + 0x2080;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    const mem = cpu.mem8, words = new Uint32Array(e.memory.buffer), raw = new Uint8Array(e.memory.buffer);
    const view = new DataView(mem.buffer, mem.byteOffset);
    const set32 = (address, value) => view.setUint32(address, value, true);
    let observe;
    const backing = address => (address < 0xA2000 ? TSS : TSS + 0x2000) + (address & 4095);
    cpu.io.mmap_register(0xA0000, 0x4000,
        address => { observe?.(address); return mem[backing(address)]; },
        () => assert.fail("permission check must not write MMIO"),
        address => { observe?.(address); return view.getInt32(backing(address), true); },
        () => assert.fail("permission check must not write MMIO"));
    let compared = 0;
    for(const op of [0xE4, 0xE6]) for(const origin of ["header", "bitmap"]) {
        for(const mutation of ["none", "xmm", "gpr", "context", "code"]) {
            const label = `${op.toString(16)}/${origin}/${mutation}`;
            assert.equal(e.ir_auto_config(0, 16, 64, 192, 256, 64), 1);
            cpu.jit_clear_cache(); e.ir_cache_collect();
            cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
            cpu.is_32[0] = cpu.stack_size_32[0] = 1;
            cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
            cpu.segment_limits.fill(0xFFFFFFFF, 0, 6);
            cpu.sreg.set([0x23, 0x1B, 0x23, 0x23, 0x23, 0x23]);
            cpu.segment_access_bytes.set([0xF3, 0xFB, 0xF3, 0xF3, 0xF3, 0xF3]);
            cpu.segment_offsets[6] = TSS; cpu.segment_limits[6] = 0x5000;
            cpu.sreg[6] = 0x28; cpu.tss_size_32[0] = 1;
            cpu.cr[0] = 0x80010011 | 0; cpu.cr[3] = 0x12000; cpu.cr[4] = 512;
            words[612 >> 2] = 3;
            set32(0x12000, 0x13007);
            for(let page = 0; page < 1024; page++) set32(0x13000 + page * 4, page * 4096 | 7);
            set32(0x13000 + (TSS >>> 12) * 4, 0xA1003);
            set32(0x13000 + ((BITMAP >>> 12)) * 4, 0xA2003);
            view.setUint16(TSS + 0x66, 0x2080, true); mem.fill(0, BITMAP, BITMAP + 256);
            cpu.reg32.set([0x1234, 0, 0, 0, 0x90000, 0, 0, 0]);
            cpu.reg_xmm32s.fill(0); cpu.reg_xmm32s.set([1, 1, 1, 1], 4);
            cpu.instruction_pointer[0] = PC; words[664 >> 2] = 0xFFFFFFFE;
            raw[e.get_pic_addr_master() + 3] = raw[e.get_pic_addr_slave() + 3] = 0;
            e.full_clear_tlb(); e.update_state_flags();
            // PXOR XMM0,XMM0; IN/OUT; PADDD XMM0,XMM1; JMP self.
            vm.write_memory(Uint8Array.of(0x66, 0x0F, 0xEF, 0xC0, op, 0x93,
                0x66, 0x0F, 0xFE, 0xC1, 0xEB, 0xFE), PC);
            vm.write_memory(Uint8Array.of(0x4B, 0xEB, 0xFE), ALT);
            assert(await cpu.ir_compile_cached(12, 2, 1, 1, 256, 64));
            let mutations = 0, ports = 0, reads = 0, output;
            observe = address => {
                reads++;
                if(mutations || (address < 0xA2000) !== (origin === "header")) return;
                mutations++;
                assert.deepEqual(Array.from(cpu.reg_xmm32s.slice(0, 4)), [0, 0, 0, 0],
                    `${label}: permission observer sees dirty XMM committed`);
                if(mutation === "xmm") cpu.reg_xmm32s.set([10, 20, 30, 40]);
                if(mutation === "gpr") {
                    cpu.reg32[0] = 0x123456AB;
                    cpu.reg32[3] = 0x13579;
                }
                if(mutation === "context") cpu.instruction_pointer[0] = ALT;
                if(mutation === "code") mem[PC + 8] = 0xFA; // PSUBD.
            };
            cpu.io.register_read(0x93, null, () => { ports++; return 0x7A; });
            cpu.io.register_write(0x93, null, value => { ports++; output = value; });
            e.main_loop(); observe = undefined;
            assert(reads >= 2, `${label}: header and bitmap were actually observed`);
            assert.equal(mutations, 1, label); assert.equal(ports, 1, `${label}: exactly one port operation`);
            assert.equal(cpu.instruction_pointer[0] >>> 0, mutation === "context" ? ALT + 1 : PC + 10, label);
            assert.equal(cpu.reg32[3], mutation === "context" ? -1 : mutation === "gpr" ? 0x13579 : 0, label);
            assert.equal(cpu.reg32[0], mutation === "gpr" ? (op === 0xE4 ? 0x1234567A : 0x123456AB)
                : op === 0xE4 ? 0x127A : 0x1234, `${label}: accumulator after the observer`);
            if(op === 0xE6) assert.equal(output, mutation === "gpr" ? 0xAB : 0x34,
                `${label}: OUT reads its accumulator after permission observers`);
            assert.deepEqual(Array.from(cpu.reg_xmm32s.slice(0, 4)),
                mutation === "xmm" ? [11, 21, 31, 41] : mutation === "code" ? [-1, -1, -1, -1]
                    : mutation === "context" ? [0, 0, 0, 0] : [1, 1, 1, 1], label);
            if(mutation === "xmm" || mutation === "context") {
                assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 3), 2,
                    `${label}: completed I/O retires once and returns before the stale tail`);
            }
            compared++;
        }
    }
    console.log(`PASS: ${wasm}: ${compared} scalar I/O permission-observer cases; TSS/header and bitmap MMIO preserve GPR/XMM/context/code mutations and one port retirement`);
} finally { await vm.destroy(); }
