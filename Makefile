CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
NASM_TEST_DIR=./tests/nasm

INSTRUCTION_TABLES=src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs

# Only the dependencies common to the generators
GEN_DEPENDENCIES=$(filter-out gen/generate_interpreter.js gen/generate_ir_decoder.js gen/ir_semantics.js gen/state_layout.js, $(wildcard gen/*.js))
INTERPRETER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_interpreter.js

STRIP_DEBUG_FLAG=
ifeq ($(STRIP_DEBUG),true)
STRIP_DEBUG_FLAG=--v86-strip-debug
endif

WASM_OPT ?= false

default: build/v86-debug.wasm
all: build/cpu-worker.js build/v86_all.js build/libv86.js build/libv86.mjs build/v86.wasm glbridge
all-debug: build/cpu-worker.js build/libv86-debug.js build/libv86-debug.mjs build/v86-debug.wasm glbridge
browser: build/cpu-worker.js build/v86_all.js

# CPU benchmark suite (tests/bench): IR vs legacy, see docs/cpu-benchmarks.md.
.PHONY: bench-build bench bench-quick ir-tier0-tests
bench-build:
	node tools/bench/build.mjs

bench: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/bench/run.mjs $(BENCH_ARGS)

bench-quick: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/bench/run.mjs --quick $(BENCH_ARGS)

# Tier-0 page functions against the interpreter on random programs.
ir-tier0-tests: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/ir/differential/tier0_fuzz.mjs 60 1
	for kind in i0 i10 i13 i19 i22 i26 s1 s3 s7 x; do FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 6 2 || exit 1; done
	node tests/ir/differential/tier0_fetch_fault.mjs

.PHONY: glbridge test-glbridge
glbridge:
	node tools/build_glbridge.mjs

test-glbridge:
	node tests/glbridge/run.cjs

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map '%outname%.map'

CLOSURE_FLAGS=\
		--generate_exports\
		--externs src/externs.js\
		--warning_level VERBOSE\
		--jscomp_error accessControls\
		--jscomp_error checkRegExp\
		--jscomp_error checkTypes\
		--jscomp_error checkVars\
		--jscomp_error conformanceViolations\
		--jscomp_error const\
		--jscomp_error constantProperty\
		--jscomp_error deprecated\
		--jscomp_error deprecatedAnnotations\
		--jscomp_error duplicateMessage\
		--jscomp_error es5Strict\
		--jscomp_error externsValidation\
		--jscomp_error globalThis\
		--jscomp_error invalidCasts\
		--jscomp_error misplacedTypeAnnotation\
		--jscomp_error missingProperties\
		--jscomp_error missingReturn\
		--jscomp_error msgDescriptions\
		--jscomp_error nonStandardJsDocs\
		--jscomp_error suspiciousCode\
		--jscomp_error strictModuleDepCheck\
		--jscomp_error typeInvalidation\
		--jscomp_error undefinedVars\
		--jscomp_error unknownDefines\
		--jscomp_error visibility\
		--use_types_for_optimization\
		--assume_function_wrapper\
		--summary_detail_level 3\
		--language_in ECMASCRIPT_2020\
		--language_out ECMASCRIPT_2020

CARGO_FLAGS_SAFE=\
		--target wasm32-unknown-unknown \
		-- \
		-C linker=tools/rust-lld-wrapper \
		-C link-args="--import-table --global-base=4096 $(STRIP_DEBUG_FLAG)" \
		-C link-args="build/softfloat.o" \
		-C link-args="build/zstddeclib.o" \
		--verbose

CARGO_FLAGS=$(CARGO_FLAGS_SAFE) -C target-feature=+bulk-memory -C target-feature=+multivalue -C target-feature=+simd128

CORE_FILES=cjs.js const.js io.js machine_clock.js main.js lib.js buffer.js ide.js pci.js floppy.js \
	   dma.js pit.js vga.js ps2.js rtc.js uart.js parallel.js vmware.js \
	   acpi.js acpi_tables.js platform.js state_layout.js iso9660.js \
	   state.js ne2k.js sb16.js virtio.js virtio_console.js virtio_net.js virtio_balloon.js \
	   v86gl_pci.js \
	   bus.js log.js cpu.js \
	   elf.js kernel.js
LIB_FILES=9p.js filesystem.js marshall.js
BROWSER_FILES=screen.js keyboard.js mouse.js speaker.js serial.js \
	      network.js starter.js wasm_paths.js worker_bus.js cpu_worker.js dummy_screen.js ansi_screen.js \
	      inbrowser_network.js fake_network.js wisp_network.js fetch_network.js \
          print_stats.js filestorage.js modem.js graphics_performance.js performance_recorder.js

RUST_FILES=$(shell find src/rust/ -name '*.rs') \
	   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs

CORE_FILES:=$(addprefix src/,$(CORE_FILES))
LIB_FILES:=$(addprefix lib/,$(LIB_FILES))
BROWSER_FILES:=$(addprefix src/browser/,$(BROWSER_FILES))

build/v86_all.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	-ls -lh build/v86_all.js
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all.js\
		--define=DEBUG=false\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js
	ls -lh build/v86_all.js

build/v86_all_debug.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all_debug.js\
		--define=DEBUG=true\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js

build/libv86.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.js\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86.js

build/libv86.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.mjs\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86.mjs

build/libv86-debug.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.js\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86-debug.js

build/libv86-debug.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.mjs\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86-debug.mjs

src/rust/gen/interpreter.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter
src/rust/gen/interpreter0f.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f

build/v86.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86.wasm
	cargo rustc --release $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm
	@if [ "$(WASM_OPT)" != "false" ]; then $(WASM_OPT) && wasm-opt -O2 --strip-debug build/v86.wasm -o build/v86.wasm; fi
	BLOCK_SIZE=K ls -l build/v86.wasm

build/v86-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-debug.wasm
	cargo rustc $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm
	BLOCK_SIZE=K ls -l build/v86-debug.wasm

build/v86-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release $(CARGO_FLAGS_SAFE)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86-fallback.wasm || true

debug-with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm || true

with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm || true

watch:
	cargo watch -x 'rustc $(CARGO_FLAGS)' -s 'cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm'

build/softfloat.o: lib/softfloat/softfloat.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DSOFTFLOAT_FAST_INT64 -DINLINE_LEVEL=5 -DSOFTFLOAT_FAST_DIV32TO16 -DSOFTFLOAT_FAST_DIV64TO32 \
	    -o build/softfloat.o \
	    lib/softfloat/softfloat.c

build/zstddeclib.o: lib/zstd/zstddeclib.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DZSTDLIB_VISIBILITY="" \
	    -o build/zstddeclib.o \
	    lib/zstd/zstddeclib.c

clean:
	-rm build/libv86.js
	-rm build/libv86.mjs
	-rm build/libv86-debug.js
	-rm build/libv86-debug.mjs
	-rm build/v86_all.js
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm $(INSTRUCTION_TABLES)
	-rm build/*.map
	-rm build/*.wast
	-rm build/*.o
	$(MAKE) -C $(NASM_TEST_DIR) clean

run: browser glbridge build/v86.wasm
	python3 tools/dev-server.py 2> /dev/null

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</code>' ;\
	REPLACE='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	SEARCH='<script src="build/v86_all.js?[a-f0-9]\+"></script>' ;\
	REPLACE='<script src="build/v86_all.js?'$$COMMIT'"></script>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	grep $$COMMIT index.html


$(CLOSURE):
	mkdir -p $(CLOSURE_DIR)
	# don't upgrade until https://github.com/google/closure-compiler/issues/3972 is fixed
	wget -nv -O $(CLOSURE) https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/v20210601/closure-compiler-v20210601.jar

build/integration-test-fs/fs.json: images/buildroot-bzimage68.bin
	mkdir -p build/integration-test-fs/flat
	cp images/buildroot-bzimage68.bin build/integration-test-fs/bzImage
	touch build/integration-test-fs/initrd
	cd build/integration-test-fs && tar cfv fs.tar bzImage initrd
	./tools/fs2json.py build/integration-test-fs/fs.tar --out build/integration-test-fs/fs.json
	./tools/copy-to-sha256.py build/integration-test-fs/fs.tar build/integration-test-fs/flat
	rm build/integration-test-fs/fs.tar build/integration-test-fs/bzImage build/integration-test-fs/initrd

tests: build/v86-debug.wasm build/integration-test-fs/fs.json
	LOG_LEVEL=3 ./tests/full/run.js

tests-release: build/libv86.js build/v86.wasm build/integration-test-fs/fs.json
	TEST_RELEASE_BUILD=1 ./tests/full/run.js

nasmtests: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js

nasmtests-force-jit: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js --force-jit

jitpagingtests: build/v86-debug.wasm
	$(MAKE) -C tests/jit-paging test-jit test-jit-smc
	./tests/jit-paging/run.js
	./tests/jit-paging/run-smc.js

qemutests: build/v86-debug.wasm
	$(MAKE) -C tests/qemu test-i386
	LOG_LEVEL=3 ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

qemutests-release: build/libv86.mjs build/v86.wasm
	$(MAKE) -C tests/qemu test-i386
	TEST_RELEASE_BUILD=1 time ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

# kvm-unit-tests are built out of tree in build/kvm-unit-tests/<arch>/ (also on
# macOS, see tests/kvm-unit-tests/build.sh)
KVM_UNIT_TESTS=build/kvm-unit-tests/i386/x86

kvm-unit-test: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh i386 x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
	tests/kvm-unit-tests/run.mjs $(KVM_UNIT_TESTS)/taskswitch.flat
	tests/kvm-unit-tests/run.mjs --expect-pass 11 $(KVM_UNIT_TESTS)/taskswitch2.flat
	tests/kvm-unit-tests/run.mjs --expect-pass 127 $(KVM_UNIT_TESTS)/realmode.flat

kvm-unit-test-release: build/libv86.mjs build/v86.wasm
	tests/kvm-unit-tests/build.sh i386 x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs $(KVM_UNIT_TESTS)/taskswitch.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs --expect-pass 11 $(KVM_UNIT_TESTS)/taskswitch2.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs --expect-pass 127 $(KVM_UNIT_TESTS)/realmode.flat

# Interrupt controller tests (ACPI enables the APIC in v86).
kvm-unit-test-apic: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh i386 x86/ioapic.flat x86/smptest.flat x86/apic.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 19 $(KVM_UNIT_TESTS)/ioapic.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 1 $(KVM_UNIT_TESTS)/smptest.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 11 $(KVM_UNIT_TESTS)/apic.flat

expect-tests: build/v86-debug.wasm build/libwabt.cjs
	make -C tests/expect/tests
	./tests/expect/run.js

acpi-device-tests: build/v86-debug.wasm
	./tests/devices/acpi_device.js

acpi-guest-tests: build/v86-debug.wasm
	./tests/devices/acpi_guest.js
	DISABLE_JIT=1 ./tests/devices/acpi_guest.js
	GUEST=linux4 ./tests/devices/acpi_guest.js

# ACPICA's iasl/acpiexec are used when found on PATH or in IASL/ACPIEXEC
acpi-table-tests:
	./tests/devices/acpi_tables.js

.PHONY: acpi-device-tests acpi-table-tests acpi-guest-tests acpi-tests
acpi-tests: acpi-table-tests acpi-device-tests acpi-guest-tests

devices-test: build/v86-debug.wasm
	./tests/devices/virtio_9p.js
	./tests/devices/virtio_console.js
	./tests/devices/fetch_network.js
	USE_VIRTIO=1 ./tests/devices/fetch_network.js
	./tests/devices/fetch_network_post.js
	./tests/devices/wisp_network.js
	./tests/devices/virtio_balloon.js

rust-test: $(RUST_FILES)
	env RUSTFLAGS="-D warnings" RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

build/softfloat-fast-test.wasm: tests/rust/softfloat_fast_path.rs src/rust/softfloat.rs src/rust/x87_profiler.rs build/softfloat.o
	rustc --edition=2021 --target wasm32-unknown-unknown --crate-type cdylib -O \
	    -C linker=tools/rust-lld-wrapper -C link-arg=build/softfloat.o \
	    tests/rust/softfloat_fast_path.rs -o $@

softfloat-fast-tests: build/softfloat-fast-test.wasm
	node tests/rust/softfloat_fast_path.mjs

x87-recording-tests: build/softfloat-fast-test.wasm
	node tests/rust/x87_recording.mjs

x87-fast-math-tests: build/softfloat-fast-test.wasm
	node tests/rust/x87_fast_math.mjs

x87-jit-cache-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/x87_jit_cache.mjs

build/x87-fast-test.bin: tests/rust/x87_fast_path.asm
	nasm -f bin $< -o $@

x87-fast-tests: build/x87-fast-test.bin build/v86.wasm build/libv86.mjs
	node tests/rust/x87_fast_path.mjs

.PHONY: cpu-optimization-tests cpu-optimization-benchmark
cpu-optimization-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_optimizations.mjs

.PHONY: flags-provenance-tests
flags-provenance-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/flags_provenance.mjs

.PHONY: cpu-plan-tests jit-policy-benchmark
cpu-plan-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_plan_sequences.mjs

jit-policy-benchmark: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/jit_policy_benchmark.mjs

.PHONY: jit-tiers-tests
jit-tiers-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/jit_tiers.mjs

.PHONY: mmx-fast-tests
mmx-fast-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/mmx_fast_path.mjs

# Preserve a baseline before rebuilding, or pass paths directly to the script.
cpu-optimization-benchmark: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_optimizations_benchmark.mjs

build/jit-capacity.bin: tests/rust/jit_capacity.asm
	nasm -f bin $< -o $@

build/performance-recording-test: tests/rust/performance_recording.rs src/rust/profiler.rs
	rustc --edition=2021 --test -O $< -o $@

performance-recording-tests: build/performance-recording-test
	./build/performance-recording-test

api-tests: build/v86-debug.wasm
	./tests/api/clean-shutdown.js
	./tests/api/state.js
	./tests/api/reset.js
	./tests/api/floppy.js
	./tests/api/parallel.js
	./tests/api/cdrom-insert-eject.js
	./tests/api/iso9660.js
	./tests/api/serial.js
	./tests/api/reboot.js
	#./tests/api/reboot-buildroot.js # https://github.com/copy/v86/issues/636
	./tests/api/pic.js

all-tests: eslint kvm-unit-test qemutests qemutests-release jitpagingtests api-tests nasmtests nasmtests-force-jit rust-test tests expect-tests
	# Skipping:
	# - devices-test (hangs)

eslint:
	eslint src tests gen lib examples tools

rustfmt: $(RUST_FILES)
	cargo fmt --all -- --check --config fn_single_line=true,control_brace_style=ClosingNextLine

build/capstone-x86.min.js:
	mkdir -p build
	wget -nv -P build https://github.com/AlexAltea/capstone.js/releases/download/v3.0.5-rc1/capstone-x86.min.js

# Recent enough for the SIMD and multi-value code the IR compiler emits.
build/libwabt.cjs:
	mkdir -p build
	wget -nv -O build/wabt-1.0.39.tgz https://registry.npmjs.org/wabt/-/wabt-1.0.39.tgz
	tar -xzf build/wabt-1.0.39.tgz -C build package/index.js
	mv build/package/index.js build/libwabt.cjs
	rm -r build/wabt-1.0.39.tgz build/package

# The page always loads the serial terminal; its CSS is included in v86.css.
# Never leave an empty/partial target behind when a download fails.
build/xterm.js:
	mkdir -p build
	curl --fail --location --retry 2 https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.min.js --output $@.tmp
	mv $@.tmp $@

build/xterm.js.map:
	mkdir -p build
	curl --fail --location --retry 2 https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.js.map --output $@.tmp
	mv $@.tmp $@

update-package-json-version:
	git describe --tags --exclude latest | sed 's/-/./' | tr - + | tee build/version
	jq --arg version "$$(cat build/version)" '.version = $$version' package.json > package.json.tmp
	mv package.json.tmp package.json

doc:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	npx typedoc --readme none --customFooterHtml "Commit: <a href='https://github.com/copy/v86/commits/$$COMMIT'><code>$$COMMIT</code></a>" --out ./docs/api ./v86.d.ts

denodoc:
	deno doc --html --name="v86 API" --output=./docs/api ./v86.d.ts

.PHONY: tests

.PHONY: packed-simd-tests
packed-simd-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/packed_simd.mjs

.PHONY: sse3-tests
sse3-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-fallback.wasm build/v86-debug.wasm
	node tests/rust/sse3.mjs
	node tests/rust/sse3.mjs build/v86-fallback.wasm
	node tests/rust/sse3.mjs build/v86-debug.wasm

# Keep the worker's public option/event wire names stable across bundles.
build/cpu-worker.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--js $(CORE_FILES) --js $(LIB_FILES) --js $(BROWSER_FILES) \
		--js src/browser/cpu_worker_runtime.js --js src/browser/cpu_worker_entry.js

build/cpu-worker-test.bin: tests/rust/cpu_worker.asm
	nasm -f bin $< -o $@

.PHONY: cpu-worker-tests
cpu-worker-tests: build/cpu-worker.js build/cpu-worker-test.bin build/libv86.mjs build/libv86.js build/v86_all.js build/v86.wasm glbridge
	node tests/glbridge/cpu_worker_screen_test.mjs
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_gpu_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_audio_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_ui_browser_test.html

# A browser/library rebuild must ship the matching wire-protocol implementation.
build/v86_all.js build/v86_all_debug.js build/libv86.js build/libv86.mjs build/libv86-debug.js build/libv86-debug.mjs: | build/cpu-worker.js

# Keep the terminal available even when building the page bundle directly.
build/v86_all.js build/v86_all_debug.js: | build/xterm.js

# IR tests exercise the experimental compiler without changing the production backend.
.PHONY: ir-generated ir-generated-check ir-decoder-tests ir-verifier-tests ir-backend-tests ir-semantics-tests ir-differential-tests ir-tests
ir-generated:
	node gen/generate_ir_decoder.js

ir-generated-check:
	node gen/generate_ir_decoder.js --check

# CPU state layout: generated global_pointers.rs constants, src/state_layout.js,
# and the owner of every Rust static (gen/state_layout.js)
state-layout:
	node gen/state_layout.js

state-layout-check:
	node gen/state_layout.js --check

# Multicore building blocks (docs/acpi-x86-64-multicore-plan.zh-CN.md, P2a/C1)
build/smp/core_swap.bin: tests/smp/core_swap.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

smp-tests: build/smp/core_swap.bin build/v86-debug.wasm
	node gen/state_layout.js --check
	./tests/smp/core_swap.mjs
	DISABLE_JIT=1 ./tests/smp/core_swap.mjs

build/smp/ap_startup.bin: tests/smp/ap_startup.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

build/smp/firmware_boot.bin: tests/smp/firmware_boot.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

# C1 guest startup and interrupt routing; clock/topology/coherence gates below.
multicore-boot-tests: build/smp/ap_startup.bin build/smp/firmware_boot.bin build/v86-debug.wasm state-layout-check
	node tests/smp/apic_routing.mjs
	node tests/smp/scheduler.mjs
	node tests/smp/ap_startup.mjs
	node tests/smp/firmware_boot.mjs

multicore-boot-tests-release: build/smp/ap_startup.bin build/smp/firmware_boot.bin build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/apic_routing.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/scheduler.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/ap_startup.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/firmware_boot.mjs

# C0/C3 focused gates. OS tests are separate because they need Linux media.
multicore-clock-tests: build/v86-debug.wasm
	node tests/smp/clock.mjs
	node tests/smp/clock_execution.mjs

multicore-coherence-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/coherence.mjs
	node tests/smp/lifecycle.mjs
	node tests/smp/exception_lifecycle.mjs
	node tests/smp/publication.mjs

multicore-clock-tests-release: build/libv86.mjs build/v86.wasm
	node tests/smp/clock.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/clock_execution.mjs

multicore-coherence-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/coherence.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/exception_lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/publication.mjs

multicore-atomic-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/atomic_boundaries.mjs

multicore-atomic-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/atomic_boundaries.mjs

multicore-memory-order-tests: build/v86-debug.wasm
	node tests/smp/memory_order.mjs

multicore-memory-order-tests-release: build/libv86.mjs build/v86.wasm
	TEST_RELEASE_BUILD=1 node tests/smp/memory_order.mjs

multicore-statistics-tests: build/v86-debug.wasm
	node tests/smp/core_statistics.mjs

multicore-statistics-tests-release: build/libv86.mjs build/v86.wasm
	TEST_RELEASE_BUILD=1 node tests/smp/core_statistics.mjs

multicore-os-stress-tests: build/v86-debug.wasm images/linux4.iso
	node tests/smp/os_stress.mjs

multicore-os-stress-tests-release: build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 node tests/smp/os_stress.mjs

.PHONY: multicore-atomic-tests multicore-atomic-tests-release multicore-memory-order-tests multicore-memory-order-tests-release multicore-statistics-tests multicore-statistics-tests-release multicore-os-stress-tests multicore-os-stress-tests-release

.PHONY: multicore-clock-tests multicore-clock-tests-release multicore-coherence-tests multicore-coherence-tests-release

.PHONY: state-layout state-layout-check smp-tests multicore-boot-tests multicore-boot-tests-release

ir-decoder-tests: ir-generated-check
	cargo test decode::tests -- --nocapture
	node tests/ir/decode/oracle.mjs

ir-verifier-tests: ir-generated-check
	cargo test ir::core_tests

ir-backend-tests: ir-generated-check
	cargo test
	node tests/ir/wasm/run.mjs
	node tests/rust/verify-wasmgen-dummy-output.js

ir-semantics-tests: ir-generated-check
	cargo test ir::core_tests::register_lowering_corpus

ir-differential-tests: ir-semantics-tests build/v86.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/registers.mjs

ir-tests: ir-generated-check build/v86.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test
	node tests/ir/decode/oracle.mjs
	node tests/ir/wasm/run.mjs
	node tests/rust/verify-wasmgen-dummy-output.js
	node tests/ir/differential/registers.mjs

.PHONY: ir-coverage ir-default-gate
ir-coverage: ir-generated-check
	node tests/ir/coverage.mjs

# Every valid decoder form must have an attributed IR lowering path.
ir-default-gate: ir-generated-check
	node tests/ir/coverage.mjs --require-complete

build/v86-ir-test.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

.PHONY: ir-decode-snapshot-tests
ir-decode-snapshot-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs
	cargo test decode::tests::catalogue_lengths_and_all_modrm_sib_forms
	node tests/ir/decode/snapshot.mjs

.PHONY: ir-memory-tests
ir-memory-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::memory_tests
	node tests/ir/differential/memory.mjs

.PHONY: ir-stack-tests
ir-stack-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::stack_tests
	node tests/ir/differential/stack.mjs

.PHONY: ir-control-tests
ir-control-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::control_tests
	node tests/ir/differential/control.mjs

.PHONY: ir-shift-tests
ir-shift-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::shift_tests
	node tests/ir/differential/shifts.mjs

.PHONY: ir-multiply-tests
ir-multiply-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::multiply_tests
	node tests/ir/differential/multiply.mjs

.PHONY: ir-bit-tests
ir-bit-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::bit_tests
	node tests/ir/differential/bits.mjs

.PHONY: ir-exchange-tests
ir-exchange-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::exchange_tests
	node tests/ir/differential/exchange.mjs

.PHONY: ir-enter-tests
ir-enter-tests: ir-generated-check build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::enter_tests
	node tests/ir/differential/enter.mjs

# ENTER16's pinned debug-only value assertion rejects high ESP before truncation.
# The release oracle matches production, including nested unwrap fault behavior.
build/v86-ir-test-release.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

.PHONY: ir-misc-tests
ir-misc-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::misc_tests
	node tests/ir/differential/misc.mjs

.PHONY: ir-loop-tests
ir-loop-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::loop_tests
	node tests/ir/differential/loops.mjs

.PHONY: ir-cfg-tests
ir-cfg-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cfg_frontend_tests
	node tests/ir/differential/cfg.mjs

.PHONY: ir-fusion-tests
ir-fusion-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test ir::fusion_tests
	node tests/ir/differential/fusion.mjs
	node tests/ir/differential/fusion.mjs build/v86-ir-test-release.wasm

.PHONY: ir-diagnostic-tests
ir-diagnostic-tests: build/v86-ir-runtime.wasm build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/diagnostics.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/diagnostics.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/diagnostics.mjs build/v86-ir-runtime.wasm
	IR_DIAGNOSTICS=16 node tests/ir/differential/auto.mjs build/v86-ir-runtime.wasm

.PHONY: ir09-completion-tests
ir09-completion-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test ir::backend::structure::tests -- --nocapture
	env RUSTFLAGS="-D warnings" cargo test ir::runtime::region::tests -- --nocapture
	env RUSTFLAGS="-D warnings" cargo test ir::cfg_frontend_tests -- --nocapture
	node tests/ir/differential/cfg.mjs

.PHONY: ir-system-stack-tests
ir-system-stack-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::system_stack_tests
	node tests/ir/differential/system_stack.mjs

.PHONY: ir-segment-tests
ir-segment-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::segment_tests
	node tests/ir/differential/segments.mjs

.PHONY: ir-string-tests
ir-string-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::string_tests
	node tests/ir/differential/strings.mjs

.PHONY: ir-io-tests
ir-io-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::io_tests
	node tests/ir/differential/io.mjs

.PHONY: ir-rep-engine-tests
build/v86-rep-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_rep_reference.py
	python3 tests/ir/differential/build_rep_reference.py

ir-rep-engine-tests: ir-generated-check build/v86-ir-test.wasm build/v86-rep-reference.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/rep_engine.mjs

.PHONY: ir-rep-tests
ir-rep-tests: ir-generated-check build/v86-ir-test.wasm build/v86-rep-reference.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::rep_tests
	node tests/ir/differential/rep.mjs

.PHONY: ir-cpu-info-tests
ir-cpu-info-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cpu_info_tests
	node tests/ir/differential/cpu_info.mjs

.PHONY: ir-cpu-system-tests
ir-cpu-system-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cpu_system_tests
	node tests/ir/differential/cpu_system.mjs

.PHONY: ir-control-regs-tests
ir-control-regs-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::control_regs_tests
	node tests/ir/differential/control_regs.mjs
	node tests/ir/differential/system_read_continuation.mjs

.PHONY: ir-descriptor-tests
ir-descriptor-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::descriptor_tests
	node tests/ir/differential/descriptor.mjs

build/v86-task-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_task_reference.py
	python3 tests/ir/differential/build_task_reference.py

build/v86-task-reference-release.wasm: build/v86-task-reference.wasm
	test -f $@ || python3 tests/ir/differential/build_task_reference.py

.PHONY: ir-task-regs-tests
ir-task-regs-tests: ir-generated-check build/v86-task-reference.wasm build/v86-task-reference-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::task_regs_tests
	node tests/ir/differential/task_regs.mjs

.PHONY: ir-selector-query-tests
ir-selector-query-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::selector_query_tests
	node tests/ir/differential/selector_query.mjs

.PHONY: ir-flags-observer-tests
ir-flags-observer-tests: build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/verr_flags_baseline.mjs

.PHONY: ir-verr-tests
ir-verr-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::verr_tests
	node tests/ir/differential/verr.mjs
	node tests/ir/differential/raw_zero.mjs

.PHONY: ir-cmpxchg8b-tests
ir-cmpxchg8b-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cmpxchg8b_tests
	node tests/ir/differential/cmpxchg8b.mjs

.PHONY: ir-x87-tests
ir-x87-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::x87_tests
	node tests/ir/differential/x87.mjs

.PHONY: ir-far-control-tests ir-x87-memory-tests ir-fp-state-tests ir-control-reference-tests
ir-far-control-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::far_control_tests
	node tests/ir/differential/far_control.mjs
	node tests/ir/differential/far_control.mjs build/v86-ir-test-release.wasm

ir-x87-memory-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::x87_memory_tests
	node tests/ir/differential/x87_memory.mjs

ir-fp-state-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::fp_state_tests
	node tests/ir/differential/fp_state.mjs

build/v86-control-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_control_reference.py
	python3 tests/ir/differential/build_control_reference.py

build/v86-control-reference-release.wasm: build/v86-control-reference.wasm
	@test -f $@ || python3 tests/ir/differential/build_control_reference.py

ir-control-reference-tests: ir-far-control-tests ir-x87-memory-tests ir-fp-state-tests ir-coverage-tests build/v86-control-reference.wasm build/v86-control-reference-release.wasm
	node tests/ir/differential/far_control.mjs build/v86-control-reference.wasm
	node tests/ir/differential/far_control.mjs build/v86-control-reference-release.wasm
	node tests/ir/differential/x87_memory.mjs build/v86-control-reference
	node tests/ir/differential/fp_state.mjs build/v86-control-reference
	node tests/ir/differential/coverage.mjs build/v86-control-reference

.PHONY: ir-simd-move-tests
ir-simd-move-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_move_tests
	node tests/ir/differential/simd_moves.mjs

.PHONY: ir-simd-integer-tests
ir-simd-integer-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_integer_tests
	node tests/ir/differential/simd_integer.mjs

.PHONY: ir-simd-immediate-tests
ir-simd-immediate-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_immediate_tests
	node tests/ir/differential/simd_immediate.mjs

.PHONY: ir-simd-shuffle-tests
ir-simd-shuffle-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_shuffle_tests
	node tests/ir/differential/simd_shuffle.mjs

.PHONY: ir-simd-transfer-tests
ir-simd-transfer-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_transfer_tests
	node tests/ir/differential/simd_transfer.mjs

.PHONY: ir-simd-lane-tests
ir-simd-lane-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_lane_tests
	node tests/ir/differential/simd_lane.mjs

.PHONY: ir-simd-masked-tests
ir-simd-masked-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_masked_tests
	node tests/ir/differential/simd_masked.mjs

.PHONY: ir-entry-tests
ir-entry-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::entry_tests
	node tests/ir/differential/entry.mjs
	node tests/ir/differential/entry.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/shared_entry.mjs
	node tests/ir/differential/shared_entry.mjs build/v86-ir-test-release.wasm

.PHONY: ir-live-tests
ir-live-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::entry_tests
	node tests/ir/differential/live.mjs
	node tests/ir/differential/live.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/live_runtime.mjs

# The release core without differential test hooks: the same as build/v86.wasm,
# under the path the IR tests use.
build/v86-ir-runtime.wasm: build/v86.wasm
	cp build/v86.wasm $@

.PHONY: ir-cache-tests
ir-cache-tests: ir-generated-check build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/fp_debug_deferral.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/fp_debug_deferral.mjs build/v86-ir-cache-test-release.wasm --release
	node tests/ir/differential/cache.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/cache.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/cache.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-runtime.wasm
	node tests/ir/performance/timing_test.mjs

.PHONY: ir-auto-tests
ir-auto-tests: ir-generated-check build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/auto.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/auto.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/auto.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-runtime.wasm

.PHONY: ir-backend-integration-tests ir-backend-browser-tests
ir-backend-integration-tests: build/v86-ir-cache-test.wasm build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/ir/differential/backend.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/backend.mjs build/v86-ir-runtime.wasm

ir-backend-browser-tests: build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker.js build/cpu-worker-test.bin
	node tests/glbridge/gl_multipass_browser_runner.js ir_backend_browser_test.html

# IR-13 host/device acceptance deliberately reuses the production Worker/browser
# integration scenarios instead of a reduced IR-only fixture. The query string
# selects the experimental core while preserving the exact graphics/audio/state
# workload used by the legacy regression.
.PHONY: ir13-host-tests ir13-browser-tests
ir13-host-tests: ir-backend-integration-tests
	@echo "PASS: IR-13 Node host/backend integration"

ir13-browser-tests: build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker.js build/cpu-worker-test.bin
	node tests/glbridge/gl_multipass_browser_runner.js ir_backend_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_browser_test.html?jit_backend=ir'
	node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_audio_browser_test.html?jit_backend=ir'

.PHONY: ir13-budget-matrix
ir13-budget-matrix: build/v86-ir-runtime.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/ir/performance/smoke.mjs > build/ir13-performance-smoke.json
	cat build/ir13-performance-smoke.json

.PHONY: jit-disabled-tests
jit-disabled-tests: build/v86-debug.wasm build/v86.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/rust/jit_disabled_promotion.mjs build/v86-debug.wasm
	node tests/rust/jit_disabled_promotion.mjs build/v86.wasm

.PHONY: ir-mir-owned-tests
ir-mir-owned-tests:
	cargo test mir::optimize::tests
	node tests/ir/wasm/owned.mjs

build/v86-ir-cache-test.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

build/v86-ir-cache-test-release.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

.PHONY: ir-forwarding-tests
ir-forwarding-tests:
	tools/ir-forwarding-tests.sh

.PHONY: ir-sse-fp-tests
ir-sse-fp-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::sse_fp_tests
	node tests/ir/differential/sse_fp.mjs

.PHONY: ir-mmx-tests
ir-mmx-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::mmx_tests
	node tests/ir/differential/mmx.mjs

.PHONY: ir-coverage-tests
ir-coverage-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/coverage.mjs --require-complete
	cargo test ir::coverage_tests
	node tests/ir/differential/coverage.mjs

.PHONY: ir-sti-tests
ir-sti-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::sti_tests
	node tests/ir/differential/sti.mjs

.PHONY: ir-helper-reload-tests
ir-helper-reload-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::helper_tests::cpu_reload_contract_and_continuation_fixtures
	node tests/ir/differential/reload.mjs

# Portable IR core: scalar regions compile, vector regions explicitly fall back
# to the interpreter and participate in normal failed-compilation suppression.
build/v86-ir-runtime-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release $(CARGO_FLAGS_SAFE) -C target-feature=-simd128
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

build/v86-ir-test-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS_SAFE) -C target-feature=-simd128
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

.PHONY: ir-decode-contract-tests ir-system-mode-tests ir-portable-tests ir-helper-audit
ir-decode-contract-tests: ir-decode-snapshot-tests build/v86-ir-test-release.wasm build/jit-capacity.bin
	cargo test invalid_form_fixtures
	node tests/ir/decode/staged.mjs
	node tests/ir/decode/staged.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/invalid.mjs
	node tests/ir/differential/invalid.mjs build/v86-ir-test-release.wasm
	cargo test multiple_cpu_entries
	node tests/ir/differential/multientry.mjs
	node tests/ir/differential/multientry.mjs build/v86-ir-test-release.wasm

ir-system-mode-tests: ir-far-control-tests build/v86-control-reference.wasm build/v86-control-reference-release.wasm
	node tests/ir/differential/system_modes.mjs
	node tests/ir/differential/system_modes.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/system_modes.mjs build/v86-control-reference.wasm
	node tests/ir/differential/system_modes.mjs build/v86-control-reference-release.wasm

ir-portable-tests: build/v86-ir-test.wasm build/v86-ir-test-fallback.wasm build/v86-ir-runtime-fallback.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test portable_core
	node tests/ir/differential/fallback.mjs
	node tests/ir/differential/auto.mjs build/v86-ir-runtime-fallback.wasm

# Full fixture set is also produced by cargo test --lib in CI.
ir-helper-audit: ir-generated-check
	cargo test ir::simd_
	cargo test sse_fp_fixtures
	cargo test mmx_fixtures
	node tests/ir/differential/helper_audit.mjs

# The pinned resolver is compiled into test cores via #[path].
build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/v86-ir-test-fallback.wasm build/v86-control-reference.wasm build/v86-control-reference-release.wasm: tests/ir/decode/legacy_modrm.rs

.PHONY: ir-budget-batch-tests
ir-budget-batch-tests:
	sh tools/ir-budget-batch-tests.sh

# C2: CPUID and firmware-input agreement, followed by real 32-bit Linux SMP.
build/smp/affinity_probe: tests/smp/affinity_probe.asm
	mkdir -p build/smp
	nasm -f bin $< -o $@

multicore-topology-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/topology.mjs

multicore-topology-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/topology.mjs

multicore-linux-tests: build/smp/affinity_probe build/v86-debug.wasm images/linux4.iso
	node tests/smp/linux_topology.mjs

multicore-linux-tests-release: build/smp/affinity_probe build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 node tests/smp/linux_topology.mjs

.PHONY: multicore-topology-tests multicore-topology-tests-release multicore-linux-tests multicore-linux-tests-release

multicore-linux-jit-tests: build/smp/affinity_probe build/v86-debug.wasm images/linux4.iso
	SMP_JIT_MODE=tier0 node tests/smp/linux_topology.mjs
	SMP_JIT_MODE=region node tests/smp/linux_topology.mjs

multicore-linux-jit-tests-release: build/smp/affinity_probe build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 SMP_JIT_MODE=tier0 node tests/smp/linux_topology.mjs
	TEST_RELEASE_BUILD=1 SMP_JIT_MODE=region node tests/smp/linux_topology.mjs

.PHONY: multicore-linux-jit-tests multicore-linux-jit-tests-release
