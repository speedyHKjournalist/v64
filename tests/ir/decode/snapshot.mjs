// IR code capture (ir::runtime::snapshot) reads only RAM: it declines MMIO and
// unallocated physical memory, and an instruction continuing past a captured
// page is an incomplete decode (a compile stop), never a read beyond it.
import assert from "node:assert/strict";
import {V86} from "../../../build/libv86.mjs";
const vm = new V86({wasm_path: "build/v86-ir-test.wasm", memory_size: 32 << 20,
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    // Paging is off: linear addresses are physical.
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    const saved_ip = cpu.instruction_pointer[0];
    const snapshot = e.ir_test_snapshot_length;
    assert.equal(snapshot(0x300040, 15), 15);
    assert.equal(snapshot(0x300FFF, 2), 2, "a capture may continue on the next RAM page");
    assert.equal(snapshot(0xA0000, 1), 0, "MMIO is never captured");
    assert.equal(snapshot(0x9FFFF, 2), 0, "nor a capture running into MMIO");
    assert.equal(snapshot(32 << 20, 1), 0, "unallocated physical RAM is never read");
    assert.equal(snapshot((32 << 20) - 1, 2), 0, "nor a capture running past the end of RAM");
    cpu.mem8[0x300040] = 0x90;
    assert.equal(e.ir_test_snapshot_decode(0x300040), 1);
    cpu.mem8[0x300FFF] = 0xB8;
    assert.equal(e.ir_test_snapshot_decode(0x300FFF), 2, "an instruction continuing on the next page is a compile stop");
    assert.equal(e.ir_test_snapshot_decode(0xA0000), 0);
    assert.equal(cpu.instruction_pointer[0], saved_ip, "capture/decode does not advance real CPU EIP");
    console.log("PASS: IR code capture stops at MMIO, unallocated RAM and page ends without moving EIP");
} finally { await vm.destroy(); }
