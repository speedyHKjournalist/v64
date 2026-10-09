#!/usr/bin/env python3
"""Pin interpreter LTR/LLDT bodies independently of the current IR adapters."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
COMMIT = "8ee73e538daaab15411344d39a1f271e778ac7f3"
SOURCE = "src/rust/cpu/cpu.rs"
# load_tr and load_ldt stay pinned, although 0128f9ab deliberately rewrote
# load_tr_checked and load_ldt, which the IR calls, to deliver #GP/#NP where
# these bodies panic: null LTR selectors, selectors outside the GDT, wrong
# descriptor types, not-present descriptors and LDT-relative selectors (a debug
# assertion here; release builds look them up in the LDT). 8d7a3927 also made a
# faulting busy-bit store a clean #PF. Wherever these bodies complete, they
# still agree with today's, and task_regs.mjs has no other independent oracle
# for its load, MMIO, descriptor-fault, remap and page-straddle comparisons;
# unpinned, it would compare load_tr_checked with itself. Where these bodies
# panic, task_regs.mjs expects the reference to trap and checks the fault the
# IR delivers. The busy-bit store panics only after delivering the same #PF,
# so there it still compares everything else.
#
# Edits that let the pinned LTR body compile against today's helpers without
# changing what it does; each `before` occurs exactly once in the body. Since
# 8d7a3927, lookup_segment_selector returns descriptor addresses as u64 (IA-32e
# tables can lie above 4 GiB). Outside long mode that is the 32-bit linear
# address the old body computed as i32, and write_descriptor_access_byte casts
# it the same way.
ADAPTATIONS = [
    ("translate_address_system_write(descriptor_address + 5)", "translate_address_system_write(descriptor_address as i32 + 5)"),
]
old = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE}"], cwd=ROOT).decode()
a = old.index("pub unsafe fn load_tr(selector: i32)")
b = old.index("pub unsafe fn load_ldt(selector: i32)", a)
c = old.index("\n#[no_mangle]", b)
tr, ldt = old[a:b], old[b:c]
tr_adapted = tr
for before, after in ADAPTATIONS:
    assert tr_adapted.count(before) == 1, before
    tr_adapted = tr_adapted.replace(before, after)
current = (ROOT / SOURCE).read_text()
a = current.index("pub unsafe fn load_tr(selector: i32)")
b = current.index("// Explicit read-fault status", a)
reference = current[:a] + tr_adapted + current[b:] + "\n" + ldt.replace("fn load_ldt(", "fn load_ldt_reference(", 1)
with tempfile.TemporaryDirectory(prefix="task-reference-", dir=ROOT / "build") as folder:
    stage = Path(folder)
    shutil.copytree(ROOT / "src/rust", stage / "src/rust")
    shutil.copytree(ROOT / "tests/ir", stage / "tests/ir")
    for name in ["Cargo.toml", "Cargo.lock"]:
        shutil.copy2(ROOT / name, stage / name)
    (stage / SOURCE).write_text(reference)
    instructions = stage / "src/rust/cpu/instructions_0f.rs"
    instructions.write_text(instructions.read_text().replace("load_ldt(", "load_ldt_reference("))
    target = ROOT / "build/task-reference-target"
    hashes = {}
    for release in [False, True]:
        subprocess.run([
            "cargo", "rustc", "--manifest-path", str(stage / "Cargo.toml"), "--target-dir", str(target),
            *(["--release"] if release else []), "--features", "ir-test-hooks", "--target", "wasm32-unknown-unknown", "--",
            "-C", f"linker={ROOT / 'tools/rust-lld-wrapper'}", "-C", "link-args=--import-table --global-base=4096 --export=__stack_pointer",
            "-C", f"link-args={ROOT / 'build/softfloat.o'}", "-C", f"link-args={ROOT / 'build/zstddeclib.o'}",
            "-C", "target-feature=+bulk-memory,+multivalue,+simd128",
        ], cwd=ROOT, check=True)
        output = ROOT / ("build/v86-task-reference-release.wasm" if release else "build/v86-task-reference.wasm")
        shutil.copy2(target / "wasm32-unknown-unknown" / ("release" if release else "debug") / "v86.wasm", output)
        hashes["release" if release else "debug"] = hashlib.sha256(output.read_bytes()).hexdigest()
    (ROOT / "build/task-reference.json").write_text(json.dumps({
        "commit": COMMIT, "source": SOURCE, "ltr_sha256": hashlib.sha256(tr.encode()).hexdigest(),
        "lldt_sha256": hashlib.sha256(ldt.encode()).hexdigest(), "ltr_adaptations": ADAPTATIONS, "wasm_sha256": hashes,
        "scope": "Interpreter load_tr/load_ldt bodies pinned; IR adapters and other CPU code from working tree",
        "test_exports": ["__stack_pointer"],
    }, indent=2) + "\n")
