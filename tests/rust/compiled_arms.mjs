// Compiled-code arms for tests that compare generated code with the
// interpreter. IR is the only compiler, with two code generators: Tier-0 page
// functions (on by default) and the region tiers, which run alone when Tier-0
// is off. Tests run their compiled side once per arm.
export const COMPILED_ARMS = [
    { label: "tier0", options: {} },
    { label: "regions", options: { ir_tier0: false } },
];

// Activations of compiled IR code of either kind. The performance recording
// counters cannot show this: Tier-0 does not run while recording is enabled.
export function compiled_activations(exports)
{
    return (exports["ir_t0_entries"]() + exports["ir_cache_stat"](2)) >>> 0;
}
