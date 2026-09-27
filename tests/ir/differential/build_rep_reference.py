#!/usr/bin/env python3
"""Build an isolated CPU whose interpreter strings use the pinned pre-refactor body."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
COMMIT = "8ee73e538daaab15411344d39a1f271e778ac7f3"
SOURCE = "src/rust/cpu/string.rs"
old = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE}"], cwd=ROOT).decode()
start = old.index("// We implement all string instructions here")
end = old.index("\n#[no_mangle]\npub unsafe fn movsb_rep", start)
body = old[start:end].replace("unsafe fn string_instruction(", "unsafe fn string_instruction_reference(", 1)
current = (ROOT / SOURCE).read_text()
start = current.index("// Interpreter callers retain their unbounded/page-bounded execution policy.")
end = current.index("/// Explicit progress", start)
wrapper = """#[inline(always)]
unsafe fn string_instruction(is_asize_32: bool, ds_or_prefix: i32, instruction: Instruction, size: Size, rep: Rep) {
    string_instruction_reference(is_asize_32, ds_or_prefix, instruction, size, rep)
}

"""
reference = current[:start] + wrapper + current[end:] + "\n" + body
with tempfile.TemporaryDirectory(prefix="rep-reference-", dir=ROOT / "build") as stage_name:
    stage = Path(stage_name)
    shutil.copytree(ROOT / "src/rust", stage / "src/rust")
    shutil.copytree(ROOT / "tests/ir", stage / "tests/ir")
    for name in ["Cargo.toml", "Cargo.lock"]:
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, stage / name)
    (stage / SOURCE).write_text(reference)
    target = ROOT / "build/rep-reference-target"
    subprocess.run([
        "cargo", "rustc", "--manifest-path", str(stage / "Cargo.toml"),
        "--target-dir", str(target), "--features", "ir-test-hooks", "--target", "wasm32-unknown-unknown", "--",
        "-C", f"linker={ROOT / 'tools/rust-lld-wrapper'}",
        "-C", "link-args=--import-table --global-base=4096",
        "-C", f"link-args={ROOT / 'build/softfloat.o'}", "-C", f"link-args={ROOT / 'build/zstddeclib.o'}",
        "-C", "target-feature=+bulk-memory,+multivalue,+simd128",
    ], cwd=ROOT, check=True)
    output = ROOT / "build/v86-rep-reference.wasm"
    shutil.copy2(target / "wasm32-unknown-unknown/debug/v86.wasm", output)
    (ROOT / "build/rep-reference.json").write_text(json.dumps({
        "commit": COMMIT, "source": SOURCE,
        "engine_sha256": hashlib.sha256(body.encode()).hexdigest(),
        "wasm_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "scope": "Legacy string_instruction body pinned; other CPU code from working tree",
    }, indent=2) + "\n")
