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
SOURCES = {
    "src/rust/cpu/misc_instr.rs": ["fxsave", "fxrstor"],
    "src/rust/cpu/cpu.rs": ["iret", "call_interrupt_vector", "far_jump", "far_return", "do_task_switch", "safe_read_write16"],
    "src/rust/cpu/fpu.rs": ["fpu_frstor32", "fpu_fsave32"],
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
            a, b = function_span(current, name)
            current = current[:a] + body + current[b:]
            body_hashes[name] = hashlib.sha256(body.encode()).hexdigest()
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
        "commit": COMMIT, "body_sha256": body_hashes, "wasm_sha256": hashes,
        "scope": "Interpreter control, FSAVE/FRSTOR, FXSAVE/FXRSTOR and word RMW bodies pinned; checked IR adapters and other CPU code from working tree",
    }, indent=2) + "\n")
