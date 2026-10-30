(function(global) {
    "use strict";
    const cases = [
        { name: "shared_globals_separate_macros", uniform: "tint", value: [0, 0.25, 0, 1], vertex: [
            "#version 120\n#define FACTOR 0.125\nuniform vec4 tint; float mainLocal = FACTOR; float shared = 0.125; float helper(); varying vec4 v; void main() { gl_Position = gl_Vertex; float result = helper(); v = vec4(mainLocal + result + shared, tint.g, 0.25, 1.0); }",
            "#version 120\n#ifndef FACTOR\n#define FACTOR 0.25\n#endif\nuniform vec4 tint; float helperLocal = FACTOR; float shared = 0.25 / 2.0; float helper() { shared += 0.125; return helperLocal + tint.r; }",
        ], fragment: [
            "#version 120\nuniform vec4 tint; float mainB = 0.25; vec4 shade(vec4 x); varying vec4 v; void main() { gl_FragColor = shade(v) + vec4(0.0, 0.0, mainB, 0.0); }",
            "#version 120\nuniform vec4 tint; float helperB = 0.125; vec4 shade(vec4 x) { return vec4(x.r, x.g + helperB + tint.g, x.b, 1.0); }",
        ] },
        { name: "distinct_structs", vertex: [
            "#version 120\nstruct Record { vec4 value; }; Record mainState = Record(vec4(0.25)); float helper(); void main() { gl_Position = gl_Vertex; gl_FrontColor = vec4(mainState.value.x + helper(), 0.0, 0.0, 1.0); }",
            "#version 120\nstruct HelperRecord { float value; }; HelperRecord helperState = HelperRecord(0.5); float helper() { return helperState.value; }",
        ], fragment: ["#version 120\nvoid main() { gl_FragColor = gl_Color; }"] },
        { name: "shared_struct_uniform", uniform: "settings.tint", value: [0.25, 0.5, 0.75, 1], vertex: [
            "#version 120\nstruct State { vec4 tint; }; uniform State settings; vec4 unit_tint(); varying vec4 color; void main() { gl_Position = gl_Vertex; color = unit_tint(); }",
            "#version 120\nstruct State { vec4 tint; }; uniform State settings; vec4 unit_tint() { return settings.tint; }",
        ], fragment: ["#version 120\nvarying vec4 color; void main() { gl_FragColor = color; }"] },
    ];
    cases.appendProgram = (stream, entry, base) => {
        let id = base + 1;
        stream.call("CREATE_PROGRAM", base);
        for (const stage of ["vertex", "fragment"]) for (const source of entry[stage]) {
            stream.call("CREATE_SHADER", id, stage === "vertex" ? 0x8B31 : 0x8B30).shaderSource(id, source)
                .call("COMPILE_SHADER", id).call("ATTACH_SHADER", base, id++);
        }
        // glShaderSource does not invalidate the last successful compile.
        stream.shaderSource(base + 2, "this text has not been compiled");
        return stream.call("LINK_PROGRAM", base).call("USE_PROGRAM", base);
    };
    global.GLShaderUnitCases = cases;
    if (typeof module !== "undefined" && module.exports) module.exports = cases;
})(typeof globalThis !== "undefined" ? globalThis : this);
