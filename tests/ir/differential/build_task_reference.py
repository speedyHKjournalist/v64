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
old = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE}"], cwd=ROOT).decode()
a = old.index("pub unsafe fn load_tr(selector: i32)")
b = old.index("pub unsafe fn load_ldt(selector: i32)", a)
c = old.index("\n#[no_mangle]", b)
tr, ldt = old[a:b], old[b:c]
current = (ROOT / SOURCE).read_text()
a = current.index("pub unsafe fn load_tr(selector: i32)")
b = current.index("// Explicit read-fault status", a)
reference = current[:a] + tr + current[b:] + "\n" + ldt.replace("fn load_ldt(", "fn load_ldt_reference(", 1)
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
        "lldt_sha256": hashlib.sha256(ldt.encode()).hexdigest(), "wasm_sha256": hashes,
        "scope": "Interpreter load_tr/load_ldt bodies pinned; IR adapters and other CPU code from working tree",
        "test_exports": ["__stack_pointer"],
    }, indent=2) + "\n")
