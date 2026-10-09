#!/usr/bin/env python3
"""Pin pre-adapter control/FPU semantic bodies while retaining current IR adapters."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
COMMIT = "90f90481d438317a14f8f68c2a81e3d28ae0a11c"
# FXSAVE and FXRSTOR are not pinned any more. The SIMD/XSAVE plan's P2
# (8c6ccc8c, docs/simd-xsave-plan.md section 14) replaced both bodies on purpose
# with the XSAVE-area codec in src/rust/cpu/xstate.rs, which the interpreter
# and the IR's adapters share. A misaligned operand now raises #GP(0) (the old
# bodies only had a dbg_assert), every field is checked for page faults before
# any byte moves, fields move in 8-byte and single-byte pieces, and FXRSTOR
# reads the whole area before it checks MXCSR. Against the old bodies,
# fp_state.mjs fails in its MMIO cases: they store FOP, FIP and FCS as write8,
# write8, write32, write8, write8, the codec as two write32s. The codec is
# tested by `cargo test cpu::xstate` and `make xsave-tests`, and
# `make ir-fp-state-tests` compares the IR's adapters with the interpreter.
#
# do_task_switch stays pinned, although 0128f9ab deliberately rewrote
# do_task_switch_checked, which the IR calls: it now checks both TSSs and reads
# the new one before it commits, and it delivers #GP/#TS/#NP/#PF where the old
# body panics. On every task switch the old body completes, the two still
# agree, and system_modes.mjs has no other independent oracle for task
# switches; unpinned, its reference runs would compare do_task_switch_checked
# with itself. Two of its scenarios take a page fault on a TSS. There the old
# body delivers the same #PF and then panics in unwrap(), so the test expects
# the reference to trap and the IR to complete. For the new TSS it also
# expects the IR to leave alone the old-task save and the busy bits that the
# old body writes first.
SOURCES = {
    "src/rust/cpu/cpu.rs": ["iret", "call_interrupt_vector", "far_jump", "far_return", "do_task_switch", "safe_read_write16"],
    "src/rust/cpu/fpu.rs": ["fpu_frstor32", "fpu_fsave32"],
}
# Edits that let a pinned body compile against today's helpers without changing
# what it does; each `before` occurs exactly once in the body. Since 8d7a3927,
# lookup_segment_selector returns descriptor addresses as u64 (IA-32e tables
# can lie above 4 GiB). Outside long mode that is the 32-bit linear address the
# old body computed as i32, and do_task_switch_checked casts it the same way.
ADAPTATIONS = {
    "do_task_switch": [
        ("safe_write64(tr_descriptor_address, ", "safe_write64(tr_descriptor_address as i32, "),
        ("safe_write64(descriptor_address, ", "safe_write64(descriptor_address as i32, "),
    ],
}

def function_span(text, name):
    start = text.index("pub unsafe fn " + name + "(")
    opening = text.index("{", start)
    # These selected functions have no column-zero inner closing braces.
    line_end = text.index("\n", opening)
    if "}" in text[opening:line_end]:
        end = text.index("}", opening) + 1
    else:
        end = text.index("\n}", opening) + 2
    return start, end

with tempfile.TemporaryDirectory(prefix="control-reference-", dir=ROOT / "build") as folder:
    stage = Path(folder)
    shutil.copytree(ROOT / "src/rust", stage / "src/rust")
    shutil.copytree(ROOT / "tests/ir", stage / "tests/ir")
    for name in ["Cargo.toml", "Cargo.lock"]:
        shutil.copy2(ROOT / name, stage / name)
    body_hashes = {}
    for source, names in SOURCES.items():
        old = subprocess.check_output(["git", "show", f"{COMMIT}:{source}"], cwd=ROOT).decode()
        current = (stage / source).read_text()
        for name in names:
            a, b = function_span(old, name)
            body = old[a:b]
            body_hashes[name] = hashlib.sha256(body.encode()).hexdigest()
            for before, after in ADAPTATIONS.get(name, []):
                assert body.count(before) == 1, (name, before)
                body = body.replace(before, after)
            a, b = function_span(current, name)
            current = current[:a] + body + current[b:]
        (stage / source).write_text(current)
    target = ROOT / "build/control-reference-target"
    hashes = {}
    for release in [False, True]:
        subprocess.run([
            "cargo", "rustc", "--manifest-path", str(stage / "Cargo.toml"), "--target-dir", str(target),
            *(["--release"] if release else []), "--features", "ir-test-hooks", "--target", "wasm32-unknown-unknown", "--",
            "-C", f"linker={ROOT / 'tools/rust-lld-wrapper'}", "-C", "link-args=--import-table --global-base=4096",
            "-C", f"link-args={ROOT / 'build/softfloat.o'}", "-C", f"link-args={ROOT / 'build/zstddeclib.o'}",
            "-C", "target-feature=+bulk-memory,+multivalue,+simd128",
        ], cwd=ROOT, check=True)
        output = ROOT / ("build/v86-control-reference-release.wasm" if release else "build/v86-control-reference.wasm")
        shutil.copy2(target / "wasm32-unknown-unknown" / ("release" if release else "debug") / "v86.wasm", output)
        hashes["release" if release else "debug"] = hashlib.sha256(output.read_bytes()).hexdigest()
    (ROOT / "build/control-reference.json").write_text(json.dumps({
        "commit": COMMIT, "body_sha256": body_hashes, "adaptations": ADAPTATIONS, "wasm_sha256": hashes,
        "scope": "Interpreter control, FSAVE/FRSTOR and word RMW bodies pinned; FXSAVE/FXRSTOR (cpu/xstate.rs since SIMD/XSAVE P2), checked IR adapters and other CPU code from working tree",
    }, indent=2) + "\n")
