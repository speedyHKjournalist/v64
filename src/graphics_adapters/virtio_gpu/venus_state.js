// Snapshots of Venus contexts: the Vulkan model's objects as JSON (a v86
// snapshot holds arrays, numbers, strings and typed arrays, not objects).
// An object that points at another of the context's objects keeps its id;
// what the graph points at but does not own (the context, a blob) becomes
// [kind, id] for the caller to find again.

const TYPED = {
    "Uint8Array": Uint8Array, "Int8Array": Int8Array, "Uint16Array": Uint16Array, "Int16Array": Int16Array,
    "Uint32Array": Uint32Array, "Int32Array": Int32Array, "Float32Array": Float32Array, "Float64Array": Float64Array,
};

/**
 * @param {!Map<number, !Object>} objects by id
 * @param {function(!Object): Array} outside [kind, id] of an object owned elsewhere, else null
 * @return {string}
 */
export function encode_objects(objects, outside)
{
    const ids = new Map();
    for(const [id, o] of objects) ids.set(o, id);
    const value = (v, top) => {
        if(v === undefined || typeof v === "function") return null;
        if(typeof v === "number" && !Number.isFinite(v)) return { "$n": String(v) };
        if(v === null || typeof v !== "object") return v;
        const o = /** @type {!Object} */ (v);
        if(!top && ids.has(o)) return { "$r": ids.get(o) };
        const other = outside(o);
        if(other) return { "$o": other };
        if(ArrayBuffer.isView(o)) return { "$t": o.constructor.name, "d": Array.from(/** @type {!IArrayLike<number>} */ (o)) };
        if(o instanceof Map) return { "$m": [...o].map(([k, x]) => [value(k, false), value(x, false)]) };
        if(o instanceof Set) return { "$s": [...o].map(x => value(x, false)) };
        if(Array.isArray(o)) return o.map(x => value(x, false));
        const out = {};
        for(const key of Object.keys(o)) out[key] = value(o[key], false);
        return out;
    };
    return JSON.stringify([...objects].map(([id, o]) => [id, value(o, true)]));
}

/**
 * @param {string} json from encode_objects
 * @param {function(!Array): *} resolve what [kind, id] was
 * @return {!Map<number, !Object>} by id
 */
export function decode_objects(json, resolve)
{
    const entries = /** @type {!Array<!Array>} */ (JSON.parse(json));
    // the objects first, empty, so that references find them
    const objects = new Map();
    for(const [id] of entries) objects.set(id, {});
    const value = v => {
        if(v === null || typeof v !== "object") return v;
        if(Array.isArray(v)) return v.map(value);
        const o = /** @type {!Object} */ (v);
        if("$r" in o) return objects.get(o["$r"]) || null;
        if("$o" in o) return resolve(o["$o"]);
        if("$n" in o) return Number(o["$n"]);
        if("$t" in o) return new TYPED[o["$t"]](o["d"]);
        if("$m" in o) return new Map(o["$m"].map(([k, x]) => [value(k), value(x)]));
        if("$s" in o) return new Set(o["$s"].map(value));
        const out = {};
        for(const key of Object.keys(o)) out[key] = value(o[key]);
        return out;
    };
    for(const [id, o] of entries) Object.assign(objects.get(id), value(o));
    return objects;
}
