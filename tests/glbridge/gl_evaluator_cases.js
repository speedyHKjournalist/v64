"use strict";
(function(global) {
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js"), P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
        modes = global.GLSelectionCases || require("./gl_selection_cases.js");
    const sizes = [4, 1, 3, 1, 2, 3, 4, 3, 4];
    function map(s, target, domain, uorder, points, options = {}) {
        const dim = target >= GL.MAP2_COLOR_4 ? 2 : 1, k = sizes[target - (dim === 1 ? GL.MAP1_COLOR_4 : GL.MAP2_COLOR_4)] || 0,
            vorder = dim === 1 ? 1 : options.vorder || 1, ustride = options.ustride ?? k * vorder, vstride = options.vstride ?? (dim === 1 ? 0 : k), dense = [];
        if (k && uorder > 0 && uorder <= 10 && vorder > 0 && vorder <= 10 && ustride >= k && (dim === 1 || vstride >= k))
            for (let u = 0; u < uorder; ++u) for (let v = 0; v < vorder; ++v) for (let c = 0; c < k; ++c) dense.push(points[u * ustride + v * vstride + c]);
        const header = P.encodeRecord("MAP_EVALUATOR", { dimensions: dim, target, uorder, vorder, ustride, vstride, data_size: dense.length * 8, domain: [...domain, ...(dim === 1 ? [0, 1] : [])] }), bytes = new Uint8Array(header.length + dense.length * 8), view = new DataView(bytes.buffer);
        bytes.set(header); dense.forEach((n, i) => view.setFloat64(header.length + i * 8, n, true)); s.record(P.GLFN.MAP_EVALUATOR, bytes); return s;
    }
    const grid = (s, dim, un, domain, vn = 1) => s.record(P.GLFN.EVALUATOR_GRID, P.encodeRecord("EVALUATOR_GRID", { dimensions: dim, un, vn, domain: [...domain, ...(dim === 1 ? [0, 1] : [])] }));
    const coord = (s, dim, u, v = 0, operation = 0) => s.record(P.GLFN.EVAL_COORD, P.encodeRecord("EVAL_COORD", { dimensions: dim, operation, values: [u, v] }));
    const mesh = (s, dim, mode, indices) => s.record(P.GLFN.EVAL_MESH, P.encodeRecord("EVAL_MESH", { dimensions: dim, mode, indices: [...indices, ...(dim === 1 ? [0, 0] : [])] }));
    const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
    function query(s, target, pname, integer = false, capacity = 2048) {
        const bytes = new Uint8Array(32 + capacity); bytes.fill(0xA5); bytes.set(P.encodeRecord("QUERY_EVALUATOR", { target, pname, value_kind: integer ? P.C.V86GL_STATE_INTEGER : P.C.V86GL_STATE_DOUBLE, data_size: capacity }));
        s.record(P.GLFN.QUERY_EVALUATOR, bytes); return s.payloadView();
    }
    function state(s, pname, count) {
        const bytes = new Uint8Array(24 + count * 8); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_FLOAT, data_size: count * 8 }));
        s.record(P.GLFN.QUERY_STATE, bytes); return s.payloadView();
    }
    function reset(s) {
        for (let i = 0; i < 9; ++i) s.call("DISABLE", GL.MAP1_COLOR_4 + i).call("DISABLE", GL.MAP2_COLOR_4 + i);
        return s.call("DISABLE", GL.AUTO_NORMAL).call("DISABLE", GL.LIGHTING).call("DISABLE", GL.LIGHT0).call("DISABLE", GL.COLOR_MATERIAL)
            .call("COLOR4F", 0.25, 0.5, 0.75, 1).call("NORMAL3F", 0, 0, 0.25).call("TEX_COORD4F", 2, 3, 4, 5).call("ACTIVE_TEXTURE", GL.TEXTURE0).call("USE_PROGRAM", 0);
    }
    const vertexShader = "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;gl_TexCoord[0]=vec4(gl_Normal,1);}";
    function build() {
        const phases = [], add = (name, stream, response, extra) => { phases.push({ name, stream, response, ...extra }); return phases.at(-1); },
            ask = (name, stream, target, pname, integer = false) => add(name, stream, query(stream, target, pname, integer));
        const setup = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("VIEWPORT", 0, 0, 16, 16); add("setup", setup);
        for (const [name, target, pname] of [["default_vertex3", GL.MAP1_VERTEX_3, GL.COEFF], ["default_vertex4", GL.MAP2_VERTEX_4, GL.COEFF], ["default_color", GL.MAP1_COLOR_4, GL.COEFF],
            ["default_normal", GL.MAP2_NORMAL, GL.COEFF], ["default_tex4", GL.MAP1_TEXTURE_COORD_4, GL.COEFF], ["default_index", GL.MAP2_INDEX, GL.COEFF],
            ["default_order1", GL.MAP1_VERTEX_3, GL.ORDER], ["default_order2", GL.MAP2_VERTEX_4, GL.ORDER], ["default_domain2", GL.MAP2_VERTEX_4, GL.DOMAIN]]) ask(name, new GLStream(), target, pname);
        const curve = [-0.5, 0, 0, 99, 0, 1, 0, 99, 0.5, 0, 0, 99], line = [-0.5, -0.5, 0, 0.5, 0.5, 0], surface = [-0.25, -0.375, 0, -0.25, 0.375, 0, 0.25, -0.375, 0, 0.25, 0.375, 0];
        ask("strided_curve", map(new GLStream(), GL.MAP1_VERTEX_3, [-2, 2], 3, curve, { ustride: 4 }), GL.MAP1_VERTEX_3, GL.COEFF);
        ask("curve_domain", new GLStream(), GL.MAP1_VERTEX_3, GL.DOMAIN);
        ask("integer_rounding", map(new GLStream(), GL.MAP1_COLOR_4, [0, 1], 1, [-1.5, -0.5, 0.5, 1.5]), GL.MAP1_COLOR_4, GL.COEFF, true);
        function feedback(name, s, type, draw) {
            modes.query(s, { operation: 1, size: 2048, type }); modes.query(s, { operation: 2, type: GL.FEEDBACK }); draw(s);
            const response = modes.query(s, { operation: 2, type: GL.RENDER }), current = [state(s, GL.CURRENT_COLOR, 4), state(s, GL.CURRENT_NORMAL, 3), state(s, GL.CURRENT_TEXTURE_COORDS, 4)];
            const materialBytes = new Uint8Array(P.RECORDS.QUERY_PARAMETER.size + 32); materialBytes.set(P.encodeRecord("QUERY_PARAMETER", { target: GL.FRONT, pname: GL.DIFFUSE, query_kind: P.C.V86GL_PARAMETER_MATERIAL, value_kind: P.C.V86GL_STATE_FLOAT, data_size: 32 }));
            s.record(P.GLFN.QUERY_PARAMETER, materialBytes); const material = s.payloadView();
            add(name, s, response, { feedback: true, current, material });
        }
        const points = (s, dim, values) => { s.call("BEGIN", GL.POINTS); for (const value of values) coord(s, dim, ...value); s.call("END"); };
        feedback("curve_evaluation", reset(new GLStream()).call("ENABLE", GL.MAP1_VERTEX_3), GL["4D_COLOR_TEXTURE"], s => points(s, 1, [[0], [3]]));
        add("outside_without_vertex_map", coord(reset(new GLStream()), 1, 0)); add("outside_with_vertex_map", coord(new GLStream().call("ENABLE", GL.MAP1_VERTEX_3), 1, 0));
        let s = map(reset(new GLStream()), GL.MAP1_VERTEX_3, [-2, 2], 2, line).call("ENABLE", GL.MAP1_VERTEX_3); grid(s, 1, 2, [-2, 2]);
        feedback("mesh1_points", s, GL["2D"], s => mesh(s, 1, GL.POINT, [-1, 3])); feedback("mesh1_lines", new GLStream(), GL["2D"], s => mesh(s, 1, GL.LINE, [0, 2]));
        s = map(reset(new GLStream()), GL.MAP2_VERTEX_3, [0, 1, 0, 1], 2, surface, { vorder: 2 }).call("ENABLE", GL.MAP2_VERTEX_3); grid(s, 2, 2, [0, 1, 0, 1], 2);
        feedback("surface_evaluation", s, GL["4D_COLOR_TEXTURE"], s => points(s, 2, [[0.25, 0.75]]));
        for (const [name, mode, indices] of [["mesh2_points", GL.POINT, [0, 2, 0, 2]], ["mesh2_lines", GL.LINE, [0, 2, 0, 2]], ["mesh2_fill", GL.FILL, [0, 1, 0, 1]]]) feedback(name, new GLStream(), GL["2D"], s => mesh(s, 2, mode, indices));
        s = new GLStream(); map(s, GL.MAP2_TEXTURE_COORD_2, [0, 1, 0, 1], 1, [7, 8]); map(s, GL.MAP2_TEXTURE_COORD_4, [0, 1, 0, 1], 1, [1, 2, 3, 4]); map(s, GL.MAP2_VERTEX_4, [0, 1, 0, 1], 1, [0.25, 0.5, 0, 2]);
        s.call("ENABLE", GL.MAP2_TEXTURE_COORD_2).call("ENABLE", GL.MAP2_TEXTURE_COORD_4).call("ENABLE", GL.MAP2_VERTEX_4);
        feedback("highest_dimension_precedence", s, GL["4D_COLOR_TEXTURE"], s => points(s, 2, [[0.5, 0.5]]));
        s = new GLStream().call("DISABLE", GL.MAP2_VERTEX_4).call("DISABLE", GL.MAP2_TEXTURE_COORD_2).call("DISABLE", GL.MAP2_TEXTURE_COORD_4).call("ENABLE", GL.AUTO_NORMAL)
            .call("CREATE_PROGRAM", 100).call("CREATE_SHADER", 101, GL.VERTEX_SHADER).shaderSource(101, vertexShader).call("COMPILE_SHADER", 101).call("ATTACH_SHADER", 100, 101).call("LINK_PROGRAM", 100).call("USE_PROGRAM", 100);
        feedback("shader_auto_normal", s, GL["4D_COLOR_TEXTURE"], s => points(s, 2, [[0.5, 0.5]]));
        const rational = [-0.25, -0.375, 0, 1, -0.5, 0.75, 0, 2, 0.25, -0.375, 0, 1, 0.5, 0.75, 0, 2];
        s = map(new GLStream(), GL.MAP2_VERTEX_4, [0, 1, 0, 1], 2, rational, { vorder: 2 }).call("ENABLE", GL.MAP2_VERTEX_4);
        feedback("rational_auto_normal", s, GL["4D_COLOR_TEXTURE"], s => points(s, 2, [[0.5, 0.5]]));
        s = reset(new GLStream()).call("ENABLE", GL.MAP2_VERTEX_3).call("ENABLE", GL.AUTO_NORMAL).call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0);
        feedback("fixed_auto_normal", s, GL["3D_COLOR"], s => points(s, 2, [[0.5, 0.5]]));
        s = map(new GLStream().call("ENABLE", GL.COLOR_MATERIAL), GL.MAP2_COLOR_4, [0, 1, 0, 1], 1, [0.6, 0.2, 0.1, 1]).call("ENABLE", GL.MAP2_COLOR_4);
        feedback("evaluated_color_material", s, GL["3D_COLOR"], s => points(s, 2, [[0.5, 0.5]]));
        add("equal_map_domain", map(reset(new GLStream()), GL.MAP1_VERTEX_3, [0, 0], 2, line)); add("short_stride", map(new GLStream(), GL.MAP1_VERTEX_3, [0, 1], 2, line, { ustride: 2 }));
        add("zero_order", map(new GLStream(), GL.MAP1_VERTEX_3, [0, 1], 0, line)); add("order_nine", map(new GLStream(), GL.MAP1_VERTEX_3, [0, 1], 9, Array(27).fill(0)));
        add("zero_grid", grid(new GLStream(), 1, 0, [0, 1])); add("negative_grid", grid(new GLStream(), 2, 2, [0, 1, 0, 1], -1));
        add("nonzero_active_texture_map", map(new GLStream().call("ACTIVE_TEXTURE", GL.TEXTURE0 + 1), GL.MAP1_VERTEX_3, [0, 1], 2, line)); ask("nonzero_active_texture_get", new GLStream(), GL.MAP1_VERTEX_3, GL.ORDER);
        add("grid_inside_begin", grid(new GLStream().call("ACTIVE_TEXTURE", GL.TEXTURE0).call("BEGIN", GL.POINTS), 1, 2, [0, 1]).call("END"));
        add("map_inside_begin", map(new GLStream().call("BEGIN", GL.POINTS), GL.MAP1_VERTEX_3, [0, 1], 2, line).call("END"));
        add("mesh_inside_begin", mesh(new GLStream().call("BEGIN", GL.POINTS), 1, GL.POINT, [0, 1]).call("END"));
        s = grid(new GLStream(), 1, 3, [-2, 2]).call("PUSH_ATTRIB", 0x10000); grid(s, 1, 5, [-3, 3]); map(s, GL.MAP1_VERTEX_3, [2, 4], 2, line); s.call("ENABLE", GL.MAP1_VERTEX_3).call("POP_ATTRIB");
        ask("map_not_restored_by_attrib", s, GL.MAP1_VERTEX_3, GL.DOMAIN);
        s = new GLStream(); add("grid_restored_by_attrib", s, null, { grid: [state(s, GL.MAP1_GRID_SEGMENTS, 1), state(s, GL.MAP1_GRID_DOMAIN, 2), state(s, GL.MAP1_VERTEX_3, 1)] });
        s = new GLStream(); list(s, 1, 1, GL.COMPILE); const frozen = [-0.25, 0, 0, 0.25, 0, 0]; map(s, GL.MAP1_VERTEX_3, [0, 1], 2, frozen); list(s, 2); frozen[0] = 99; list(s, 3, 1);
        ask("list_frozen_map", s, GL.MAP1_VERTEX_3, GL.COEFF);
        return phases;
    }
    function expected(entry) {
        const e = JSON.parse(JSON.stringify(entry));
        // The virtual GL profile advertises eight, while this Apple driver
        // permits ten. The API must enforce its advertised limit.
        if (e.name === "order_nine") e.error = GL.INVALID_VALUE;
        // GL 2.1 5.1 prohibits Map1/2 under a nonzero ACTIVE_TEXTURE. The
        // Apple implementation ignores that restriction for vertex maps.
        if (e.name === "nonzero_active_texture_map") e.error = GL.INVALID_OPERATION;
        // GL 2.1 5.1 requires the unnormalized analytic normal with an active
        // vertex shader. Apple normalizes it in both of these native cases.
        if (e.name === "shader_auto_normal") e.values[11] = 0.375;
        if (e.name === "rational_auto_normal") e.values[11] = Math.fround(1 / 3);
        return e;
    }
    function compareFeedback(name, actual, e, check) {
        if (name === "mesh2_fill") {
            // Feedback may expose implementation tessellation (GL 2.1 5.3).
            // Check oriented area and the same rectangle's boundary vertices.
            const polygon = values => { const result = []; for (let at = 0; at < values.length;) { check(values[at++] === GL.POLYGON_TOKEN, "mesh polygon token"); const count = values[at++]; result.push(Array.from({ length: count }, () => [values[at++], values[at++]])); } return result; };
            const area = polygons => polygons.reduce((sum, points) => sum + points.reduce((a, p, i) => a + p[0] * points[(i + 1) % points.length][1] - p[1] * points[(i + 1) % points.length][0], 0), 0);
            const a = polygon(actual), b = polygon(e.values), vertices = polygons => [...new Set(polygons.flat().map(p => p.join(",")))].sort().join(";");
            check(area(a) === area(b) && vertices(a) === vertices(b), name + " tessellation preserves oriented rectangle");
        } else check(actual.length === e.values.length && actual.every((n, i) => Math.abs(n - e.values[i]) < 0.000002), name + " feedback: " + actual + " expected " + e.values);
    }
    const api = { map, grid, coord, mesh, query, state, reset, build, expected, compareFeedback, vertexShader };
    global.GLEvaluatorCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
