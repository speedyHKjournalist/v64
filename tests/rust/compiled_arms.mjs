// Compiled-code arms for tests that compare generated code with the
// interpreter. IR is the only compiler, with two code generators: Tier-0 page
// functions (on by default) and the region tiers, which run alone when Tier-0
// is off. Tests run their compiled side once per arm.
export const COMPILED_ARMS = [
    { label: "tier0", options: {} },
    { label: "regions", options: { ir_tier0: false } },
];

// The region tiers compile asynchronously: a hot run of VEX forms waits until
// no VEX instruction was interpreted (ir_interpreted_stat field 6) through a
// whole round of its program (they run natively or through the AVX helpers).
// The run calls it once a round has ended (the program sets the word at
// `marker`); it clears the word until two calls in a row found the count
// unchanged, which spans a round from its start to its end.
export function vex_settled(marker)
{
    let last = -1, quiet = 0;
    return vm => {
        const count = vm.v86.cpu.wm.exports["ir_interpreted_stat"](6, 0);
        quiet = count === last ? quiet + 1 : 0;
        last = count;
        if(quiet >= 2) return true;
        vm.write_memory(new Uint8Array(4), marker);
        return false;
    };
}

// Activations of compiled IR code of either kind. The performance recording
// counters cannot show this: Tier-0 does not run while recording is enabled.
export function compiled_activations(exports)
{
    return (exports["ir_t0_entries"]() + exports["ir_cache_stat"](2)) >>> 0;
}
