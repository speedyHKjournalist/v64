// Owned binary snapshots of renderer object graphs. References, sparse arrays,
// typed views, Map/Set and exceptional numbers survive without command replay.
(function(global) {
    "use strict";
    const MAGIC = 0x31534C47, HEADER = 24, MAX_NODES = 1000000, MAX_JSON = 64 * 1024 * 1024;
    const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
    const align = n => Math.ceil(n / 8) * 8;
    function encode(root, options = {}) {
        const nodes = [], buffers = [], ids = new Map();
        function value(v, path = "root") {
            if (v === undefined) return { n: "undefined" };
            if (typeof v === "number") return Number.isNaN(v) ? { n: "nan" } : v === Infinity ? { n: "+inf" } : v === -Infinity ? { n: "-inf" } : Object.is(v, -0) ? { n: "-0" } : v;
            if (v === null || typeof v === "string" || typeof v === "boolean") return v;
            if (typeof v !== "object") throw new Error("Unsupported GL snapshot value: " + typeof v + " at " + path);
            if (ids.has(v)) return { r: ids.get(v) };
            if (nodes.length >= MAX_NODES) throw new Error("GL snapshot object limit exceeded");
            const id = nodes.length; ids.set(v, id); nodes.push(null);
            const external = options.external?.(v);
            let node;
            if (external !== undefined) node = ["external", value(external)];
            else if (v instanceof ArrayBuffer) { node = ["buffer", buffers.length]; buffers.push(new Uint8Array(v)); }
            else if (ArrayBuffer.isView(v)) {
                const name = v.constructor.name;
                if (!Object.hasOwn(types, name)) throw new Error("Unsupported GL snapshot view " + name);
                node = ["view", name, value(v.buffer), v.byteOffset, v.byteLength];
            } else if (v instanceof Map) node = ["map", [...v].map(([k, item]) => [value(k, path + ".key"), value(item, path + ".get(" + String(k) + ")")])];
            else if (v instanceof Set) node = ["set", [...v].map(item => value(item, path + ".member"))];
            else if (Array.isArray(v)) node = ["array", v.length, Object.keys(v).map(k => [k, value(v[k], path + "[" + k + "]")])];
            else {
                const prototype = Object.getPrototypeOf(v);
                if (prototype !== null && prototype !== Object.prototype) throw new Error("Unsupported GL snapshot object " + v.constructor?.name);
                const fields = options.project?.(v) || v;
                node = ["object", prototype === null, Object.keys(fields).map(k => [k, value(fields[k], path + "." + k)])];
            }
            nodes[id] = node; return { r: id };
        }
        const graph = { root: value(root), nodes }, json = new TextEncoder().encode(JSON.stringify(graph));
        if (json.length > MAX_JSON) throw new Error("GL snapshot metadata limit exceeded");
        const total = align(HEADER + json.length) + buffers.reduce((n, b) => n + 8 + align(b.length), 0);
        if (total > 0xFFFFFFFF) throw new Error("GL snapshot byte limit exceeded");
        const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
        [MAGIC, 1, total, json.length, buffers.length, 0].forEach((n, i) => view.setUint32(i * 4, n, true));
        bytes.set(json, HEADER); let at = align(HEADER + json.length);
        for (const b of buffers) { view.setUint32(at, b.length, true); bytes.set(b, at + 8); at += 8 + align(b.length); }
        return bytes;
    }
    function decode(bytes, options = {}) {
        if (!(bytes instanceof Uint8Array) || bytes.length < HEADER) throw new Error("GL snapshot is truncated");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), jsonSize = view.getUint32(12, true), count = view.getUint32(16, true);
        if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1 || view.getUint32(8, true) !== bytes.length || view.getUint32(20, true) ||
            jsonSize > MAX_JSON || jsonSize > bytes.length - HEADER || count > MAX_NODES) throw new Error("GL snapshot header is invalid");
        const graph = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER, HEADER + jsonSize))), buffers = [];
        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length > MAX_NODES) throw new Error("GL snapshot graph is invalid");
        let at = align(HEADER + jsonSize);
        for (let i = 0; i < count; ++i) {
            if (at + 8 > bytes.length) throw new Error("GL snapshot buffer header is truncated");
            const size = view.getUint32(at, true);
            if (view.getUint32(at + 4, true) || size > bytes.length - at - 8) throw new Error("GL snapshot buffer is invalid");
            buffers.push(bytes.slice(at + 8, at + 8 + size).buffer); at += 8 + align(size);
        }
        if (at !== bytes.length) throw new Error("GL snapshot has trailing data");
        const objects = new Array(graph.nodes.length), building = new Set();
        function value(v) {
            if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return v;
            if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1) throw new Error("Invalid GL snapshot value");
            if (Object.hasOwn(v, "n")) {
                switch (v.n) { case "undefined": return undefined; case "nan": return NaN; case "+inf": return Infinity; case "-inf": return -Infinity; case "-0": return -0; }
                throw new Error("Invalid GL snapshot number");
            }
            if (!Object.hasOwn(v, "r") || !Number.isInteger(v.r) || v.r < 0 || v.r >= objects.length) throw new Error("Invalid GL snapshot reference");
            return node(v.r);
        }
        function fields(object, entries) {
            if (!Array.isArray(entries)) throw new Error("Invalid GL snapshot fields");
            const keys = new Set();
            for (const pair of entries) {
                if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || keys.has(pair[0])) throw new Error("Invalid GL snapshot field");
                keys.add(pair[0]); Object.defineProperty(object, pair[0], { value: value(pair[1]), writable: true, configurable: true, enumerable: true });
            }
        }
        function node(id) {
            if (Object.hasOwn(objects, id)) return objects[id];
            if (building.has(id)) throw new Error("Invalid GL snapshot external/view cycle");
            const n = graph.nodes[id]; if (!Array.isArray(n)) throw new Error("Invalid GL snapshot node");
            building.add(id);
            switch (n[0]) {
            case "buffer":
                if (n.length !== 2 || !Number.isInteger(n[1]) || n[1] < 0 || n[1] >= buffers.length) throw new Error("Invalid GL snapshot buffer reference");
                objects[id] = buffers[n[1]]; break;
            case "view": {
                if (n.length !== 5 || !Object.hasOwn(types, n[1]) || !Number.isInteger(n[3]) || !Number.isInteger(n[4]) || n[3] < 0 || n[4] < 0) throw new Error("Invalid GL snapshot view");
                const b = value(n[2]), type = types[n[1]], unit = type.BYTES_PER_ELEMENT || 1;
                if (!(b instanceof ArrayBuffer) || n[3] % unit || n[4] % unit || n[3] + n[4] > b.byteLength) throw new Error("Invalid GL snapshot view bounds");
                objects[id] = new type(b, n[3], n[4] / unit); break;
            }
            case "map":
                if (!Array.isArray(n[1])) throw new Error("Invalid GL snapshot map");
                objects[id] = new Map(); for (const p of n[1]) { if (!Array.isArray(p) || p.length !== 2) throw new Error("Invalid GL snapshot map entry"); objects[id].set(value(p[0]), value(p[1])); } break;
            case "set":
                if (!Array.isArray(n[1])) throw new Error("Invalid GL snapshot set");
                objects[id] = new Set(); for (const item of n[1]) objects[id].add(value(item)); break;
            case "array":
                if (!Number.isInteger(n[1]) || n[1] < 0 || n[1] > MAX_NODES) throw new Error("Invalid GL snapshot array");
                objects[id] = new Array(n[1]); fields(objects[id], n[2]); if (objects[id].length !== n[1]) throw new Error("Invalid GL snapshot array bounds"); break;
            case "object": objects[id] = n[1] ? Object.create(null) : {}; fields(objects[id], n[2]); break;
            case "external":
                if (!options.external) throw new Error("GL snapshot requires external resources");
                objects[id] = options.external(value(n[1])); break;
            default: throw new Error("Invalid GL snapshot node kind");
            }
            building.delete(id); return objects[id];
        }
        const result = value(graph.root);
        // Validate even unreachable nodes before a caller installs the state.
        for (let i = 0; i < objects.length; ++i) node(i);
        return result;
    }
    const api = { encode, decode };
    global.GLSnapshotCodec = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
