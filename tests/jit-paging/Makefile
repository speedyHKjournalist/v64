CC=gcc
CC_I386=$(CC) -m32
CFLAGS=-Wall -g -fno-strict-aliasing -fPIC -static
LDFLAGS=

ifeq ($(shell uname -s),Darwin)
# macOS has no Linux i386 toolchain: build freestanding static ELF binaries
# with clang against the minimal libc in freestanding/, linked by rust-lld.
RUST_LLD=$(shell rustc --print sysroot)/lib/rustlib/$(shell rustc -vV | sed -n 's/^host: //p')/bin/rust-lld
FREESTANDING_CFLAGS=-target i386-unknown-linux-gnu -ffreestanding -nostdlibinc -I$(CURDIR)/freestanding \
	-fno-pic -fno-stack-protector -Wall -g -fno-strict-aliasing
FREESTANDING_LIBC=freestanding/libc.c $(wildcard freestanding/*.h freestanding/sys/*.h)
define build_i386
	clang $(FREESTANDING_CFLAGS) -c $(1) -o $(2).o
	clang $(FREESTANDING_CFLAGS) -c freestanding/libc.c -o $(2).libc.o
	$(RUST_LLD) -flavor gnu -m elf_i386 -static -e _start -o $(2) $(2).o $(2).libc.o
	rm -f $(2).o $(2).libc.o
endef
else
FREESTANDING_LIBC=
define build_i386
	$(CC_I386) $(CFLAGS) $(LDFLAGS) -o $(2) $(1)
endef
endif

test-jit: test-jit.c $(FREESTANDING_LIBC)
	$(call build_i386,$(<D)/test-jit.c,$@)
test-jit-smc: test-jit-smc.c $(FREESTANDING_LIBC)
	$(call build_i386,$(<D)/test-jit-smc.c,$@)
test-jit-smc-fstenv: test-jit-smc-fstenv.c $(FREESTANDING_LIBC)
	$(call build_i386,$(<D)/test-jit-smc-fstenv.c,$@)

clean:
	rm -f test-jit test-jit-smc test-jit-smc-fstenv
