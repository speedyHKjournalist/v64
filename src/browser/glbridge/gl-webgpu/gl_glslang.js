// glslang for the GL shadow (docs/opengl-webgpu-plan.md C4, the first step:
// glslang checks and reflects desktop GLSL 1.10/1.20 on the CPU side). The
// module is the GLES host's (bios/glslang.wasm, tools/glslang/build.sh); this
// is a classic script for the v86gl device and its CPU worker, with the
// desktop entry points of tools/glslang/v86_glslang.cpp. Synchronous once
// instantiated: the shadow answers glGetShaderiv and glGetProgramiv inside
// the request that asked.

(function(global) {
    "use strict";

    // glslang's EShLanguage, by GL's shader type
    const STAGE_OF_GL_TYPE = new Map([[0x8B31, 0], [0x8B30, 4]]);
    const ERRNO_NOSYS = 52;

    class Glslang {
        /*
         * module: a compiled WebAssembly.Module (the renderer compiles it
         * and sends it to the device: modules cross to workers), or the
         * bytes, compiled here synchronously (a worker or Node; browsers
         * refuse large synchronous compiles on the page's thread).
         */
        constructor(module) {
            if (!(module instanceof WebAssembly.Module)) module = new WebAssembly.Module(module);
            this.printed = "";
            this.limits = null;
            const instance = new WebAssembly.Instance(module, this.imports());
            this.exports = instance.exports;
            if (typeof this.exports.v86_glslang_desktop_link !== "function")
                throw new Error("glslang.wasm has no desktop entry points; rebuild it (tools/glslang/build.sh)");
            this.exports._initialize();
        }

        memory() {
            return new Uint8Array(this.exports.memory.buffer);
        }

        imports() {
            const view = () => new DataView(this.exports.memory.buffer);
            return {
                env: {
                    emscripten_notify_memory_growth: () => {},
                    __syscall_getcwd: () => -ERRNO_NOSYS,
                },
                wasi_snapshot_preview1: {
                    fd_write: (fd, iovs, count, written) => {
                        let total = 0;
                        for (let i = 0; i < count; i++) {
                            const pointer = view().getUint32(iovs + 8 * i, true);
                            const length = view().getUint32(iovs + 8 * i + 4, true);
                            this.printed += new TextDecoder().decode(this.memory().subarray(pointer, pointer + length));
                            total += length;
                        }
                        view().setUint32(written, total, true);
                        return 0;
                    },
                    fd_close: () => 0,
                    fd_seek: () => ERRNO_NOSYS,
                    environ_sizes_get: (count, size) => {
                        view().setUint32(count, 0, true);
                        view().setUint32(size, 0, true);
                        return 0;
                    },
                    environ_get: () => 0,
                },
            };
        }

        withBytes(bytes, call) {
            const pointer = this.exports.v86_glslang_alloc(Math.max(1, bytes.length));
            this.memory().set(bytes, pointer);
            try {
                return call(pointer);
            } finally {
                this.exports.v86_glslang_free(pointer);
            }
        }

        output() {
            const pointer = this.exports.v86_glslang_output(), size = this.exports.v86_glslang_output_size();
            return new TextDecoder().decode(this.memory().subarray(pointer, pointer + size));
        }

        // The limits gl_Max* and the checks see, by glslangValidator's names
        setLimits(limits) {
            const text = Object.entries(limits).map(([name, value]) => name + " " + value).join("\n") + "\n";
            if (text === this.limits) return;
            this.limits = text;
            this.withBytes(new TextEncoder().encode(text + "\0"), pointer => this.exports.v86_glslang_desktop_limits(pointer));
        }

        // [{stage, source}] as the module takes them
        static pack(shaders) {
            const encoded = shaders.map(s => new TextEncoder().encode(s.source));
            const bytes = new Uint8Array(encoded.reduce((n, e) => n + 8 + (e.length + 3 & ~3), 0));
            const view = new DataView(bytes.buffer);
            let at = 0;
            shaders.forEach((s, i) => {
                view.setUint32(at, s.stage, true);
                view.setUint32(at + 4, encoded[i].length, true);
                bytes.set(encoded[i], at + 8);
                at += 8 + (encoded[i].length + 3 & ~3);
            });
            return bytes;
        }

        // One shader: {ok, log}
        compile(stage, source) {
            const packed = Glslang.pack([{ stage, source }]);
            const ok = this.withBytes(packed, pointer => this.exports.v86_glslang_desktop_compile(pointer, packed.length));
            return { ok: !!ok, log: this.output() };
        }

        // A program from any number of shaders a stage: {ok, log} and, when
        // it linked, the reflection (uniforms, inputs, outputs, ...)
        link(shaders) {
            const packed = Glslang.pack(shaders);
            this.withBytes(packed, pointer => this.exports.v86_glslang_desktop_link(pointer, packed.length));
            return JSON.parse(this.output());
        }
    }

    const api = { Glslang, STAGE_OF_GL_TYPE };
    global.V86GLGlslang = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
