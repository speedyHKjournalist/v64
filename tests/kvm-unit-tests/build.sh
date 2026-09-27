#!/bin/bash
# Build kvm-unit-tests out of tree, in build/kvm-unit-tests/<arch>/ of the v86
# checkout, so that i386 and x86_64 builds do not overwrite each other.
#
# usage: build.sh [ARCH [TEST.flat...]]
#   ARCH defaults to i386; the tests default to the ones in `make kvm-unit-test`
set -euo pipefail

src="$(cd "$(dirname "$0")"; pwd)"
arch="${1:-i386}"
shift || true
if [ $# -eq 0 ]
then
    set -- x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
fi

out="$src/../../build/kvm-unit-tests/$arch"
mkdir -p "$out"
out="$(cd "$out"; pwd)"
cd "$out"

# the test code must not use SSE/MMX
flags="-std=gnu11 -mno-sse -mno-sse2 -mno-mmx"

if [ "$(uname -s)" = Darwin ]
then
    # No Linux gcc on macOS: clang's <arch>-linux target, the lld and objcopy
    # that come with Rust, a GNU-format ar with an ELF symbol index (v86/ar.py)
    # and the 64-bit division helpers libgcc would provide (v86/builtins.c)
    rust_bin="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin"
    mkdir -p tools
    ln -sf "$rust_bin/rust-lld" tools/ld.lld
    target="$arch-unknown-linux-gnu"
    # -no-pie here, not only in CFLAGS: clang links PIE by default for Linux
    # targets and some link rules don't pass CFLAGS
    cc="clang -target $target --ld-path=$out/tools/ld.lld -no-pie -Wno-unknown-warning-option -Wno-unused-command-line-argument -Wno-varargs -Wno-error=unused-function"
    [ -f config.mak ] || "$src/configure" --arch="$arch" --cc="$cc" --ld="$out/tools/ld.lld"
    # an archive, like libgcc: link rules add both the *.o prerequisites and libgcc
    clang -target "$target" -ffreestanding -fno-pic -O2 $flags -c "$src/v86/builtins.c" -o builtins.o
    python3 "$src/v86/ar.py" rcs libbuiltins.a builtins.o
    tools=(CC="$cc $flags" OBJCOPY="$rust_bin/rust-objcopy" AR="python3 $src/v86/ar.py" libgcc="$out/libbuiltins.a")
    # realmode.c relies on gcc's `asm(".code16gcc")`; clang needs -m16 for
    # 16-bit code, so that object is built first with bits=16
    for test in "$@"
    do
        if [ "$test" = x86/realmode.flat ]
        then
            make "${tools[@]}" bits=16 x86/realmode.o
        fi
    done
    make "${tools[@]}" "$@"
else
    [ -f config.mak ] || "$src/configure" --arch="$arch"
    make CC="gcc $flags" "$@"
fi
