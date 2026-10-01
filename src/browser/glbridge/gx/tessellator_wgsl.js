// The D3D11 tessellator on the GPU: tessellator.js (the reference port, see
// there) in WGSL, function by function. One invocation per pi; three
// entry points, run in order:
//   count:    each patch's points and indices
//   scan:     where each patch's go (exclusive prefix sums, so primitives
//             keep D3D's order), the indirect arguments: the domain
//             shader's dispatch and the draw
//   generate: the points (u, v, pi) and the indices, at those places
//
// Bindings (group 0): 0 GXTessParams (uniform), 1 the hull shader's
// records (each patch's tess factors at factor_at: edges, then inside), 2
// counts, 3 offsets, 4 points, 5 indices, 6 the indirect arguments
// (dispatch x y z, then draw vertex count, instances, first vertex, first
// instance).
(function(global) {
    "use strict";

    const TESSELLATOR_WGSL = /* wgsl */ `
struct GXTessParams {
    patches: u32,
    domain: u32,        // 1 isoline, 2 tri, 3 quad
    partitioning: u32,  // 1 integer, 2 pow2, 3 fractional_odd, 4 fractional_even
    primitive: u32,     // 1 point, 2 line, 3 triangle_cw, 4 triangle_ccw
    record: u32,        // vec4s per pi in hull
    factor_at: u32,     // the tess factors' first vec4 in a record
    max_points: u32,    // the room in points
    max_indices: u32,   // the room in indices
}
@group(0) @binding(0) var<uniform> tp: GXTessParams;
@group(0) @binding(1) var<storage, read> hull: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> counts: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> offsets: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> points: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<u32>;

const EVEN = 0;
const ODD = 1;
const P_INTEGER = 1u;
const P_POW2 = 2u;
const P_FRACTIONAL_ODD = 3u;
const P_FRACTIONAL_EVEN = 4u;
const O_POINT = 1u;
const O_LINE = 2u;
const O_TRIANGLE_CW = 3u;
const O_TRIANGLE_CCW = 4u;
const FXP_ONE = 0x10000u;
const FXP_ONE_THIRD = 0x5555u;
const FXP_TWO_THIRDS = 0xaaaau;
const FXP_ONE_HALF = 0x8000u;
const FXP_FRACTION_MASK = 0xffffu;
const FXP_INTEGER_MASK = 0x7fff0000u;
const EPSILON = 0.0000152587890625;
const MIN_ODD_PLUS_HALF_EPSILON = 1.00000762939453125;
const DIAGONALS_INSIDE_TO_OUTSIDE = 0;
const DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE = 1;
const DIAGONALS_MIRRORED = 2;

var<private> RECIPROCAL: array<u32, 65> = array<u32, 65>(0xffffffffu,
    0x10000u, 0x8000u, 0x5555u, 0x4000u, 0x3333u, 0x2aabu, 0x2492u, 0x2000u, 0x1c72u, 0x199au, 0x1746u, 0x1555u, 0x13b1u, 0x1249u, 0x1111u, 0x1000u,
    0xf0fu, 0xe39u, 0xd79u, 0xccdu, 0xc31u, 0xba3u, 0xb21u, 0xaabu, 0xa3du, 0x9d9u, 0x97bu, 0x925u, 0x8d4u, 0x889u, 0x842u, 0x800u,
    0x7c2u, 0x788u, 0x750u, 0x71cu, 0x6ebu, 0x6bdu, 0x690u, 0x666u, 0x63eu, 0x618u, 0x5f4u, 0x5d1u, 0x5b0u, 0x591u, 0x572u, 0x555u,
    0x539u, 0x51fu, 0x505u, 0x4ecu, 0x4d5u, 0x4beu, 0x4a8u, 0x492u, 0x47eu, 0x46au, 0x457u, 0x444u, 0x432u, 0x421u, 0x410u, 0x400u);
var<private> FINAL_POINT_POSITION: array<i32, 33> = array<i32, 33>(0, 32, 16, 8, 17, 4, 18, 9, 19, 2, 20, 10, 21, 5, 22, 11, 23,
    1, 24, 12, 25, 6, 26, 13, 27, 3, 28, 14, 29, 7, 30, 15, 31);
var<private> LOOP_START: array<i32, 33> = array<i32, 33>(1, 1, 17, 9, 9, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2);
var<private> LOOP_END: array<i32, 33> = array<i32, 33>(0, 0, 17, 17, 25, 25, 25, 25, 29, 29, 29, 29, 29, 29, 29, 29, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 32);

struct Ctx { frac: u32, half: i32, split: i32, inv_floor: u32, inv_ceil: u32 }

// the tessellator's state
var<private> parity: i32;
var<private> original_parity: i32;
var<private> partitioning: u32;
var<private> original_partitioning: u32;
var<private> num_points: i32;
var<private> num_indices: i32;
var<private> patched: bool;
var<private> patched2: bool;
// INDEX_PATCH_CONTEXT
var<private> c_in_delta: i32;
var<private> c_in_bad: i32;
var<private> c_in_replace: i32;
var<private> c_out_base: i32;
var<private> c_out_delta: i32;
var<private> c_out_bad: i32;
var<private> c_out_replace: i32;
// INDEX_PATCH_CONTEXT2
var<private> c2_invert: i32;
var<private> c2_end: i32;
var<private> c2_bad: i32;
var<private> c2_replace: i32;
// the processed tess factors (quad: all; tri: outside 0..2, inside 0)
var<private> pf_culled: bool;
var<private> pf_minimum: bool;
var<private> pf_outside: array<u32, 4>;
var<private> pf_inside: array<u32, 2>;
var<private> pf_outside_parity: array<i32, 4>;
var<private> pf_inside_parity: array<i32, 2>;
var<private> pf_outside_ctx: array<Ctx, 4>;
var<private> pf_inside_ctx: array<Ctx, 2>;
var<private> pf_n_outside: array<i32, 4>;
var<private> pf_n_inside: array<i32, 2>;
var<private> pf_inside_base: i32;
// where this patch's points and indices go; whether they are written
var<private> writing: bool;
var<private> point_base: u32;
var<private> index_base: u32;
var<private> patch_id: u32;

fn is_nan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
// IEEE 754R min and max: a NaN second operand loses
fn fmin_(a: f32, b: f32) -> f32 { if (is_nan(b)) { return a; } return select(b, a, a < b); }
fn fmax_(a: f32, b: f32) -> f32 { if (is_nan(b)) { return a; } return select(b, a, a > b); }
fn positive(x: f32) -> bool { return !is_nan(x) && x > 0.0; }

fn float_to_fixed(x: f32) -> u32 {
    if (!positive(x)) { return 0u; }
    if (x >= 32768.0) { return 0x7fffffffu; }
    return u32(round(x * 65536.0));
}
fn fixed_to_float(x: u32) -> f32 { return f32(x >> 16u) + f32(x & FXP_FRACTION_MASK) / 65536.0; }
fn is_even(x: f32) -> bool { return (i32(x) & 1) == 0; }
fn fxp_ceil(x: u32) -> u32 { if ((x & FXP_FRACTION_MASK) != 0u) { return (x & FXP_INTEGER_MASK) + FXP_ONE; } return x; }
fn fxp_floor(x: u32) -> u32 { return x & FXP_INTEGER_MASK; }
fn odd() -> bool { return parity == ODD; }
fn hw_integer() -> bool { return partitioning == P_INTEGER || partitioning == P_POW2; }

fn remove_msb(val: i32) -> i32 {
    let v = u32(val);
    var check: u32;
    if (v <= 0xffffu) { check = select(0x8000u, 0x80u, v <= 0xffu); } else { check = select(0x80000000u, 0x800000u, v <= 0xffffffu); }
    for (var i = 0; i < 8; i++) {
        if ((v & check) != 0u) { return i32(v & ~check); }
        check = check >> 1u;
    }
    return 0;
}

fn define_point(u: u32, v: u32, offset: i32) {
    if (writing && point_base + u32(offset) < tp.max_points) {
        points[point_base + u32(offset)] = vec4<u32>(bitcast<u32>(fixed_to_float(u)), bitcast<u32>(fixed_to_float(v)), patch_id, 0u);
    }
}

fn patch_index_value(index_in: i32) -> i32 {
    var index = index_in;
    if (patched) {
        if (index >= c_out_base) {
            index = select(index + c_out_delta, c_out_replace, index == c_out_bad);
        } else {
            index = select(index + c_in_delta, c_in_replace, index == c_in_bad);
        }
    } else if (patched2) {
        if (index >= c2_invert) {
            index = select(c2_end - index, c2_replace, index == c2_bad);
        } else if (index == c2_bad) {
            index = c2_replace;
        }
    }
    return index;
}

fn define_index(index: i32, offset: i32) {
    let value = patch_index_value(index);
    if (writing && index_base + u32(offset) < tp.max_indices) {
        indices[index_base + u32(offset)] = point_base + u32(value);
    }
}

fn define_clockwise_triangle(i0: i32, i1: i32, i2: i32, base: i32) {
    define_index(i0, base);
    if (tp.primitive == O_TRIANGLE_CW) {
        define_index(i1, base + 1);
        define_index(i2, base + 2);
    } else {
        define_index(i2, base + 1);
        define_index(i1, base + 2);
    }
}

fn dump_all_points() {
    for (var p = 0; p < num_points; p++) { define_index(p, num_indices); num_indices++; }
}

fn dump_all_points_as_line_list() {
    for (var p = 1; p < num_points; p++) {
        define_index(p - 1, num_indices); num_indices++;
        define_index(p, num_indices); num_indices++;
    }
}

fn num_points_for_tess_factor(fxp: u32) -> i32 {
    if (odd()) { return i32((fxp_ceil(FXP_ONE_HALF + ((fxp + 1u) >> 1u)) * 2u) >> 16u); }
    return i32((fxp_ceil((fxp + 1u) >> 1u) * 2u) >> 16u) + 1;
}

fn compute_ctx(fxp: u32) -> Ctx {
    var ctx: Ctx;
    var half = (fxp + 1u) >> 1u;
    if (odd() || half == FXP_ONE_HALF) { half += FXP_ONE_HALF; }
    let floor_half = fxp_floor(half);
    let ceil_half = fxp_ceil(half);
    ctx.frac = half - floor_half;
    ctx.half = i32(ceil_half >> 16u);
    if (ceil_half == floor_half) {
        ctx.split = ctx.half + 1;
    } else if (odd()) {
        if (floor_half == FXP_ONE) { ctx.split = 0; } else { ctx.split = (remove_msb(i32(floor_half >> 16u) - 1) << 1u) + 1; }
    } else {
        ctx.split = (remove_msb(i32(floor_half >> 16u)) << 1u) + 1;
    }
    var floor_segments = i32((floor_half * 2u) >> 16u);
    var ceil_segments = i32((ceil_half * 2u) >> 16u);
    if (odd()) { floor_segments -= 1; ceil_segments -= 1; }
    ctx.inv_floor = RECIPROCAL[floor_segments];
    ctx.inv_ceil = RECIPROCAL[ceil_segments];
    return ctx;
}

fn place_point_1d(ctx: Ctx, point_in: i32) -> u32 {
    var point = point_in;
    var flip = false;
    if (point >= ctx.half) {
        point = (ctx.half << 1u) - point;
        if (odd()) { point -= 1; }
        flip = true;
    }
    if (point == ctx.half) { return FXP_ONE_HALF; }
    let on_ceil = u32(point);
    var on_floor = on_ceil;
    if (point > ctx.split) { on_floor -= 1u; }
    let loc_floor = on_floor * ctx.inv_floor;
    let loc_ceil = on_ceil * ctx.inv_ceil;
    var location = loc_floor * (FXP_ONE - ctx.frac) + loc_ceil * ctx.frac;
    location = (location + FXP_ONE_HALF) >> 16u;
    if (flip) { location = FXP_ONE - location; }
    return location;
}

fn stitch_regular(trapezoid: bool, diagonals: i32, base_in: i32, num_inside_points: i32, inside_base: i32, outside_base: i32) {
    var base = base_in;
    var inside = inside_base;
    var outside = outside_base;
    if (trapezoid) {
        define_clockwise_triangle(outside, outside + 1, inside, base);
        base += 3; outside++;
    }
    var p: i32;
    if (diagonals == DIAGONALS_INSIDE_TO_OUTSIDE) {
        for (p = 0; p < num_inside_points - 1; p++) {
            define_clockwise_triangle(inside, outside, outside + 1, base); base += 3;
            define_clockwise_triangle(inside, outside + 1, inside + 1, base); base += 3;
            inside++; outside++;
        }
    } else if (diagonals == DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE) {
        for (p = 0; p < (num_inside_points >> 1u) - 1; p++) {
            define_clockwise_triangle(outside, outside + 1, inside, base); base += 3;
            define_clockwise_triangle(inside, outside + 1, inside + 1, base); base += 3;
            inside++; outside++;
        }
        define_clockwise_triangle(outside, inside + 1, inside, base); base += 3;
        define_clockwise_triangle(outside, outside + 1, inside + 1, base); base += 3;
        inside++; outside++; p += 2;
        for (; p < num_inside_points; p++) {
            define_clockwise_triangle(outside, outside + 1, inside, base); base += 3;
            define_clockwise_triangle(inside, outside + 1, inside + 1, base); base += 3;
            inside++; outside++;
        }
    } else {
        for (p = 0; p < (num_inside_points >> 1u); p++) {
            define_clockwise_triangle(outside, inside + 1, inside, base); base += 3;
            define_clockwise_triangle(outside, outside + 1, inside + 1, base); base += 3;
            inside++; outside++;
        }
        for (; p < num_inside_points - 1; p++) {
            define_clockwise_triangle(inside, outside, outside + 1, base); base += 3;
            define_clockwise_triangle(inside, outside + 1, inside + 1, base); base += 3;
            inside++; outside++;
        }
    }
    if (trapezoid) {
        define_clockwise_triangle(outside, outside + 1, inside, base);
        base += 3;
    }
}

fn stitch_transition(base_in: i32, inside_base: i32, inside_half_in: i32, inside_parity: i32,
                     outside_base: i32, outside_half_in: i32, outside_parity: i32) {
    var base = base_in;
    var inside_half = inside_half_in;
    var outside_half = outside_half_in;
    if (inside_parity == ODD) { inside_half -= 1; }
    if (outside_parity == ODD) { outside_half -= 1; }
    var outside = outside_base;
    var inside = inside_base;
    let start = min(LOOP_START[inside_half], LOOP_START[outside_half]);
    let end = max(LOOP_END[inside_half], LOOP_END[outside_half]);
    if (FINAL_POINT_POSITION[0] < outside_half) {
        define_clockwise_triangle(outside, outside + 1, inside, base);
        base += 3; outside++;
    }
    for (var i = start; i <= end; i++) {
        if (FINAL_POINT_POSITION[i] < inside_half) {
            define_clockwise_triangle(inside, outside, inside + 1, base);
            base += 3; inside++;
        }
        if (FINAL_POINT_POSITION[i] < outside_half) {
            define_clockwise_triangle(outside, outside + 1, inside, base);
            base += 3; outside++;
        }
    }
    if (inside_parity != outside_parity || inside_parity == ODD) {
        if (inside_parity == outside_parity) {
            define_clockwise_triangle(inside, outside, inside + 1, base); base += 3;
            define_clockwise_triangle(inside + 1, outside, outside + 1, base); base += 3;
            inside++; outside++;
        } else if (inside_parity == EVEN) {
            define_clockwise_triangle(inside, outside, outside + 1, base); base += 3;
            outside++;
        } else {
            define_clockwise_triangle(inside, outside, inside + 1, base); base += 3;
            inside++;
        }
    }
    for (var i = end; i >= start; i--) {
        if (FINAL_POINT_POSITION[i] < outside_half) {
            define_clockwise_triangle(outside, outside + 1, inside, base);
            base += 3; outside++;
        }
        if (FINAL_POINT_POSITION[i] < inside_half) {
            define_clockwise_triangle(inside, outside, inside + 1, base);
            base += 3; inside++;
        }
    }
    if (FINAL_POINT_POSITION[0] < outside_half) {
        define_clockwise_triangle(outside, outside + 1, inside, base);
        base += 3; outside++;
    }
}

fn lower_bound() -> f32 {
    if (original_partitioning == P_FRACTIONAL_EVEN) { return 2.0; }
    return 1.0;
}
fn upper_bound() -> f32 {
    if (original_partitioning == P_FRACTIONAL_ODD) { return 63.0; }
    return 64.0;
}
fn clamp_factor(x: f32, lower: f32, upper: f32) -> f32 { return fmin_(upper, fmax_(lower, x)); }

// ---------------------------------------------------------------- quad

fn quad_process(ue0_in: f32, ve0_in: f32, ue1_in: f32, ve1_in: f32, iu_in: f32, iv_in: f32) {
    pf_culled = false;
    pf_minimum = false;
    if (!positive(ue0_in) || !positive(ve0_in) || !positive(ue1_in) || !positive(ve1_in)) { pf_culled = true; return; }
    var lower = lower_bound();
    let upper = upper_bound();
    var outside = array<f32, 4>(clamp_factor(ue0_in, lower, upper), clamp_factor(ve0_in, lower, upper),
        clamp_factor(ue1_in, lower, upper), clamp_factor(ve1_in, lower, upper));
    if (hw_integer()) { for (var e = 0; e < 4; e++) { outside[e] = ceil(outside[e]); } }
    if (original_partitioning == P_FRACTIONAL_ODD) {
        if (outside[0] > MIN_ODD_PLUS_HALF_EPSILON || outside[1] > MIN_ODD_PLUS_HALF_EPSILON || outside[2] > MIN_ODD_PLUS_HALF_EPSILON ||
            outside[3] > MIN_ODD_PLUS_HALF_EPSILON || iu_in > MIN_ODD_PLUS_HALF_EPSILON || iv_in > MIN_ODD_PLUS_HALF_EPSILON) {
            lower = 1.0 + EPSILON;
        }
    }
    var inside = array<f32, 2>(clamp_factor(iu_in, lower, upper), clamp_factor(iv_in, lower, upper));
    if (hw_integer()) { inside[0] = ceil(inside[0]); inside[1] = ceil(inside[1]); }
    num_points = 0;
    num_indices = 0;
    if (hw_integer()) {
        for (var e = 0; e < 4; e++) { pf_outside_parity[e] = select(ODD, EVEN, is_even(outside[e])); }
        for (var a = 0; a < 2; a++) { pf_inside_parity[a] = select(ODD, EVEN, is_even(inside[a]) || inside[a] == 1.0); }
    } else {
        for (var e = 0; e < 4; e++) { pf_outside_parity[e] = original_parity; }
        pf_inside_parity[0] = original_parity;
        pf_inside_parity[1] = original_parity;
    }
    for (var e = 0; e < 4; e++) { pf_outside[e] = float_to_fixed(outside[e]); }
    for (var a = 0; a < 2; a++) { pf_inside[a] = float_to_fixed(inside[a]); }
    if (hw_integer() || odd()) {
        if (pf_inside[0] == FXP_ONE && pf_inside[1] == FXP_ONE && pf_outside[0] == FXP_ONE && pf_outside[1] == FXP_ONE &&
            pf_outside[2] == FXP_ONE && pf_outside[3] == FXP_ONE) {
            pf_minimum = true;
            return;
        }
    }
    for (var e = 0; e < 4; e++) { parity = pf_outside_parity[e]; pf_outside_ctx[e] = compute_ctx(pf_outside[e]); }
    for (var a = 0; a < 2; a++) { parity = pf_inside_parity[a]; pf_inside_ctx[a] = compute_ctx(pf_inside[a]); }
    for (var e = 0; e < 4; e++) {
        parity = pf_outside_parity[e];
        pf_n_outside[e] = num_points_for_tess_factor(pf_outside[e]);
        num_points += pf_n_outside[e];
    }
    num_points -= 4;
    for (var a = 0; a < 2; a++) {
        parity = pf_inside_parity[a];
        let least = select(3, 4, pf_inside_parity[a] == ODD);
        pf_n_inside[a] = max(least, num_points_for_tess_factor(pf_inside[a]));
    }
    pf_inside_base = num_points;
    num_points += (pf_n_inside[0] - 2) * (pf_n_inside[1] - 2);
}

fn quad_generate_points() {
    var offset = 0;
    for (var edge = 0; edge < 4; edge++) {
        let par = edge & 1;
        let end = pf_n_outside[edge] - 1;
        for (var p = 0; p < end; p++) {
            let q = select(end - p, p, edge == 1 || edge == 2);
            parity = pf_outside_parity[edge];
            let param = place_point_1d(pf_outside_ctx[edge], q);
            if (par != 0) { define_point(param, select(0u, FXP_ONE, edge == 3), offset); }
            else { define_point(select(0u, FXP_ONE, edge == 2), param, offset); }
            offset++;
        }
    }
    let num_rings = min(pf_n_inside[0], pf_n_inside[1]) >> 1u;
    for (var ring = 1; ring < num_rings; ring++) {
        let start = ring;
        var end = array<i32, 2>(pf_n_inside[0] - 1 - start, pf_n_inside[1] - 1 - start);
        for (var edge = 0; edge < 4; edge++) {
            let par0 = edge & 1;
            let par1 = (edge + 1) & 1;
            let perp_point = select(end[par0], start, edge < 2);
            parity = pf_inside_parity[par0];
            let perp = place_point_1d(pf_inside_ctx[par0], perp_point);
            parity = pf_inside_parity[par1];
            for (var p = start; p < end[par1]; p++) {
                let q = select(end[par1] - (p - start), p, edge == 1 || edge == 2);
                let param = place_point_1d(pf_inside_ctx[par1], q);
                if (par1 != 0) { define_point(perp, param, offset); } else { define_point(param, perp, offset); }
                offset++;
            }
        }
    }
    if (pf_n_inside[0] > pf_n_inside[1] && pf_inside_parity[1] == EVEN) {
        let start = num_rings;
        let end = pf_n_inside[0] - 1 - start;
        parity = pf_inside_parity[0];
        for (var p = start; p <= end; p++) { define_point(place_point_1d(pf_inside_ctx[0], p), FXP_ONE_HALF, offset); offset++; }
    } else if (pf_n_inside[1] >= pf_n_inside[0] && pf_inside_parity[0] == EVEN) {
        let start = num_rings;
        let end = pf_n_inside[1] - 1 - start;
        parity = pf_inside_parity[1];
        for (var p = end; p >= start; p--) { define_point(FXP_ONE_HALF, place_point_1d(pf_inside_ctx[1], p), offset); offset++; }
    }
}

fn quad_generate_connectivity() {
    var rows = array<i32, 2>((pf_n_inside[0] + 1) >> 1u, (pf_n_inside[1] + 1) >> 1u);
    let num_rings = min(rows[0], rows[1]);
    var degenerate = array<i32, 2>(select(-1, rows[1] - 1, pf_inside_parity[1] == EVEN), select(-1, rows[0] - 1, pf_inside_parity[0] == EVEN));
    var outside_half: array<i32, 4>;
    var outside_parity: array<i32, 4>;
    var n_outside: array<i32, 4>;
    for (var e = 0; e < 4; e++) { outside_half[e] = pf_outside_ctx[e].half; outside_parity[e] = pf_outside_parity[e]; n_outside[e] = pf_n_outside[e]; }
    var inside_edge_base = pf_inside_base;
    var outside_edge_base = 0;
    for (var ring = 1; ring < num_rings; ring++) {
        var n_inside = array<i32, 2>(pf_n_inside[0] - 2 * ring, pf_n_inside[1] - 2 * ring);
        let edge0_inside_base = inside_edge_base;
        let edge0_outside_base = outside_edge_base;
        for (var edge = 0; edge < 4; edge++) {
            let par = (edge + 1) & 1;
            let num_triangles = n_inside[par] + n_outside[edge] - 2;
            var inside_base: i32;
            var outside_base: i32;
            if (edge == 3) {
                if (ring == degenerate[par]) {
                    c2_invert = inside_edge_base + 1;
                    c2_bad = outside_edge_base + n_outside[edge] - 1;
                    c2_replace = edge0_outside_base;
                    c2_end = (c2_invert << 1u) - 1;
                    inside_base = c2_invert;
                    outside_base = outside_edge_base;
                    patched2 = true;
                } else {
                    c_in_delta = inside_edge_base;
                    c_in_bad = n_inside[par] - 1;
                    c_in_replace = edge0_inside_base;
                    c_out_base = c_in_bad + 1;
                    c_out_delta = outside_edge_base - c_out_base;
                    c_out_bad = c_out_base + n_outside[edge] - 1;
                    c_out_replace = edge0_outside_base;
                    inside_base = 0;
                    outside_base = c_out_base;
                    patched = true;
                }
            } else if (edge == 2 && ring == degenerate[par]) {
                c2_invert = inside_edge_base;
                c2_bad = -1;
                c2_replace = -1;
                c2_end = c2_invert << 1u;
                inside_base = c2_invert;
                outside_base = outside_edge_base;
                patched2 = true;
            } else {
                inside_base = inside_edge_base;
                outside_base = outside_edge_base;
            }
            if (ring == 1) {
                stitch_transition(num_indices, inside_base, pf_inside_ctx[par].half, pf_inside_parity[par],
                    outside_base, outside_half[edge], outside_parity[edge]);
            } else {
                stitch_regular(true, DIAGONALS_MIRRORED, num_indices, n_inside[par], inside_base, outside_base);
            }
            patched = false;
            patched2 = false;
            num_indices += num_triangles * 3;
            outside_edge_base += n_outside[edge] - 1;
            if (edge == 2 && ring == degenerate[par]) { inside_edge_base -= n_inside[par] - 1; }
            else { inside_edge_base += n_inside[par] - 1; }
            n_outside[edge] = n_inside[par];
        }
        if (ring == 1) {
            for (var e = 0; e < 4; e++) { outside_half[e] = pf_inside_ctx[e & 1].half; outside_parity[e] = pf_inside_parity[e & 1]; }
        }
    }
    if (pf_n_inside[0] > pf_n_inside[1] && pf_inside_parity[1] == ODD) {
        patched2 = true;
        let quads = (((pf_n_inside[0] >> 1u) - (pf_n_inside[1] >> 1u)) << 1u) + select(1, 2, pf_inside_parity[0] == EVEN);
        c2_invert = outside_edge_base + quads + 2;
        c2_bad = c2_invert;
        c2_replace = outside_edge_base;
        c2_end = c2_invert + c2_invert + quads;
        stitch_regular(false, DIAGONALS_INSIDE_TO_OUTSIDE, num_indices, quads + 1, c2_invert, outside_edge_base + 1);
        patched2 = false;
        num_indices += quads * 6;
    } else if (pf_n_inside[1] >= pf_n_inside[0] && pf_inside_parity[0] == ODD) {
        patched2 = true;
        let quads = (((pf_n_inside[1] >> 1u) - (pf_n_inside[0] >> 1u)) << 1u) + select(1, 2, pf_inside_parity[1] == EVEN);
        c2_invert = outside_edge_base + quads + 1;
        c2_bad = -1;
        c2_end = c2_invert + c2_invert + quads;
        let diagonals = select(DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE, DIAGONALS_INSIDE_TO_OUTSIDE, pf_inside_parity[1] == EVEN);
        stitch_regular(false, diagonals, num_indices, quads + 1, c2_invert, outside_edge_base);
        patched2 = false;
        num_indices += quads * 6;
    }
}

fn tessellate_quad(f: array<f32, 6>) {
    quad_process(f[0], f[1], f[2], f[3], f[4], f[5]);
    if (pf_culled) { num_points = 0; num_indices = 0; return; }
    if (pf_minimum) {
        define_point(0u, 0u, 0);
        define_point(FXP_ONE, 0u, 1);
        define_point(FXP_ONE, FXP_ONE, 2);
        define_point(0u, FXP_ONE, 3);
        num_points = 4;
        if (tp.primitive == O_TRIANGLE_CW || tp.primitive == O_TRIANGLE_CCW) {
            define_clockwise_triangle(0, 1, 3, 0);
            define_clockwise_triangle(1, 2, 3, 3);
            num_indices = 6;
        } else if (tp.primitive == O_POINT) {
            dump_all_points();
        } else {
            dump_all_points_as_line_list();
        }
        return;
    }
    quad_generate_points();
    if (tp.primitive == O_POINT) { dump_all_points(); return; }
    if (tp.primitive == O_LINE) { dump_all_points_as_line_list(); return; }
    quad_generate_connectivity();
}

// ----------------------------------------------------------------- tri

fn tri_process(ue0_in: f32, ve0_in: f32, we0_in: f32, inside_in: f32) {
    pf_culled = false;
    pf_minimum = false;
    if (!positive(ue0_in) || !positive(ve0_in) || !positive(we0_in)) { pf_culled = true; return; }
    var lower = lower_bound();
    let upper = upper_bound();
    var outside = array<f32, 3>(clamp_factor(ue0_in, lower, upper), clamp_factor(ve0_in, lower, upper), clamp_factor(we0_in, lower, upper));
    if (hw_integer()) { for (var e = 0; e < 3; e++) { outside[e] = ceil(outside[e]); } }
    if (original_partitioning == P_FRACTIONAL_ODD) {
        if (outside[0] > MIN_ODD_PLUS_HALF_EPSILON || outside[1] > MIN_ODD_PLUS_HALF_EPSILON || outside[2] > MIN_ODD_PLUS_HALF_EPSILON) {
            lower = 1.0 + EPSILON;
        }
    }
    var inside = clamp_factor(inside_in, lower, upper);
    if (hw_integer()) { inside = ceil(inside); }
    num_points = 0;
    num_indices = 0;
    if (hw_integer()) {
        for (var e = 0; e < 3; e++) { pf_outside_parity[e] = select(ODD, EVEN, is_even(outside[e])); }
        pf_inside_parity[0] = select(ODD, EVEN, is_even(inside) || inside == 1.0);
    } else {
        for (var e = 0; e < 3; e++) { pf_outside_parity[e] = original_parity; }
        pf_inside_parity[0] = original_parity;
    }
    for (var e = 0; e < 3; e++) { pf_outside[e] = float_to_fixed(outside[e]); }
    pf_inside[0] = float_to_fixed(inside);
    if (hw_integer() || odd()) {
        if (pf_inside[0] == FXP_ONE && pf_outside[0] == FXP_ONE && pf_outside[1] == FXP_ONE && pf_outside[2] == FXP_ONE) {
            pf_minimum = true;
            return;
        }
    }
    for (var e = 0; e < 3; e++) { parity = pf_outside_parity[e]; pf_outside_ctx[e] = compute_ctx(pf_outside[e]); }
    parity = pf_inside_parity[0];
    pf_inside_ctx[0] = compute_ctx(pf_inside[0]);
    for (var e = 0; e < 3; e++) {
        parity = pf_outside_parity[e];
        pf_n_outside[e] = num_points_for_tess_factor(pf_outside[e]);
        num_points += pf_n_outside[e];
    }
    num_points -= 3;
    parity = pf_inside_parity[0];
    pf_n_inside[0] = max(select(3, 4, odd()), num_points_for_tess_factor(pf_inside[0]));
    pf_inside_base = num_points;
    let rings = (pf_n_inside[0] >> 1u) - 1;
    if (odd()) { num_points += 3 * (rings * (rings + 1) - rings); } else { num_points += 3 * (rings * (rings + 1)) + 1; }
}

fn tri_generate_points() {
    var offset = 0;
    for (var edge = 0; edge < 3; edge++) {
        let par = edge & 1;
        let end = pf_n_outside[edge] - 1;
        for (var p = 0; p < end; p++) {
            let q = select(end - p, p, par != 0);
            parity = pf_outside_parity[edge];
            let param = place_point_1d(pf_outside_ctx[edge], q);
            if (edge == 0) { define_point(0u, param, offset); }
            else { define_point(param, select(0u, FXP_ONE - param, edge == 2), offset); }
            offset++;
        }
    }
    parity = pf_inside_parity[0];
    let num_rings = pf_n_inside[0] >> 1u;
    for (var ring = 1; ring < num_rings; ring++) {
        let start = ring;
        let end = pf_n_inside[0] - 1 - start;
        for (var edge = 0; edge < 3; edge++) {
            let par = edge & 1;
            var perp = place_point_1d(pf_inside_ctx[0], start);
            perp = (perp * FXP_TWO_THIRDS + FXP_ONE_HALF) >> 16u;
            for (var p = start; p < end; p++) {
                let q = select(end - (p - start), p, par != 0);
                let param = place_point_1d(pf_inside_ctx[0], q);
                let shifted = param - ((perp + 1u) >> 1u);
                if (edge == 0) { define_point(perp, shifted, offset); }
                else if (edge == 1) { define_point(shifted, perp, offset); }
                else { define_point(shifted, FXP_ONE - shifted - perp, offset); }
                offset++;
            }
        }
    }
    if (!odd()) { define_point(FXP_ONE_THIRD, FXP_ONE_THIRD, offset); }
}

fn tri_generate_connectivity() {
    let num_rings = (pf_n_inside[0] + 1) >> 1u;
    var outside_half: array<i32, 3>;
    var outside_parity: array<i32, 3>;
    var n_outside: array<i32, 3>;
    for (var e = 0; e < 3; e++) { outside_half[e] = pf_outside_ctx[e].half; outside_parity[e] = pf_outside_parity[e]; n_outside[e] = pf_n_outside[e]; }
    var inside_edge_base = pf_inside_base;
    var outside_edge_base = 0;
    for (var ring = 1; ring < num_rings; ring++) {
        let n_inside = pf_n_inside[0] - 2 * ring;
        let edge0_inside_base = inside_edge_base;
        let edge0_outside_base = outside_edge_base;
        for (var edge = 0; edge < 3; edge++) {
            let num_triangles = n_inside + n_outside[edge] - 2;
            var inside_base: i32;
            var outside_base: i32;
            if (edge == 2) {
                c_in_delta = inside_edge_base;
                c_in_bad = n_inside - 1;
                c_in_replace = edge0_inside_base;
                c_out_base = c_in_bad + 1;
                c_out_delta = outside_edge_base - c_out_base;
                c_out_bad = c_out_base + n_outside[edge] - 1;
                c_out_replace = edge0_outside_base;
                patched = true;
                inside_base = 0;
                outside_base = c_out_base;
            } else {
                inside_base = inside_edge_base;
                outside_base = outside_edge_base;
            }
            if (ring == 1) {
                stitch_transition(num_indices, inside_base, pf_inside_ctx[0].half, pf_inside_parity[0],
                    outside_base, outside_half[edge], outside_parity[edge]);
            } else {
                stitch_regular(true, DIAGONALS_MIRRORED, num_indices, n_inside, inside_base, outside_base);
            }
            if (edge == 2) { patched = false; }
            num_indices += num_triangles * 3;
            outside_edge_base += n_outside[edge] - 1;
            inside_edge_base += n_inside - 1;
            n_outside[edge] = n_inside;
        }
        if (ring == 1) {
            for (var e = 0; e < 3; e++) { outside_half[e] = pf_inside_ctx[0].half; outside_parity[e] = pf_inside_parity[0]; }
        }
    }
    if (odd()) {
        define_clockwise_triangle(outside_edge_base, outside_edge_base + 1, outside_edge_base + 2, num_indices);
        num_indices += 3;
    }
}

fn tessellate_tri(f: array<f32, 6>) {
    tri_process(f[0], f[1], f[2], f[3]);
    if (pf_culled) { num_points = 0; num_indices = 0; return; }
    if (pf_minimum) {
        define_point(0u, FXP_ONE, 0);
        define_point(0u, 0u, 1);
        define_point(FXP_ONE, 0u, 2);
        num_points = 3;
        if (tp.primitive == O_TRIANGLE_CW || tp.primitive == O_TRIANGLE_CCW) {
            define_clockwise_triangle(0, 1, 2, num_indices);
            num_indices = 3;
        } else if (tp.primitive == O_POINT) {
            dump_all_points();
        } else {
            dump_all_points_as_line_list();
        }
        return;
    }
    tri_generate_points();
    if (tp.primitive == O_POINT) { dump_all_points(); return; }
    if (tp.primitive == O_LINE) { dump_all_points_as_line_list(); return; }
    tri_generate_connectivity();
}

// ------------------------------------------------------------- isoline

fn tessellate_isoline(density_in: f32, detail_in: f32) {
    if (!positive(density_in) || !positive(detail_in)) { num_points = 0; num_indices = 0; return; }
    var density = fmin_(64.0, fmax_(1.0, density_in));
    var detail = clamp_factor(detail_in, lower_bound(), upper_bound());
    num_points = 0;
    num_indices = 0;
    var detail_parity: i32;
    if (hw_integer()) {
        detail = ceil(detail);
        detail_parity = select(ODD, EVEN, is_even(detail));
    } else {
        detail_parity = original_parity;
    }
    let fxp_detail = float_to_fixed(detail);
    parity = detail_parity;
    let detail_ctx = compute_ctx(fxp_detail);
    let per_line = num_points_for_tess_factor(fxp_detail);
    partitioning = P_INTEGER;
    density = ceil(density);
    let density_parity = select(ODD, EVEN, is_even(density));
    parity = density_parity;
    let fxp_density = float_to_fixed(density);
    let density_ctx = compute_ctx(fxp_density);
    let lines = num_points_for_tess_factor(fxp_density) - 1;
    partitioning = original_partitioning;
    num_points = per_line * lines;
    var offset = 0;
    for (var line = 0; line < lines; line++) {
        for (var point = 0; point < per_line; point++) {
            parity = density_parity;
            let v = place_point_1d(density_ctx, line);
            parity = detail_parity;
            let u = place_point_1d(detail_ctx, point);
            define_point(u, v, offset);
            offset++;
        }
    }
    offset = 0;
    var index = 0;
    for (var line = 0; line < lines; line++) {
        for (var point = 0; point < per_line; point++) {
            if (tp.primitive == O_POINT) {
                define_index(offset, index); index++;
            } else if (point > 0) {
                define_index(offset - 1, index); index++;
                define_index(offset, index); index++;
            }
            offset++;
        }
    }
    num_indices = index;
}

// -------------------------------------------------------- entry points

fn tessellate(pi: u32) {
    patch_id = pi;
    partitioning = tp.partitioning;
    original_partitioning = tp.partitioning;
    parity = select(EVEN, ODD, tp.partitioning == P_FRACTIONAL_ODD);
    original_parity = parity;
    num_points = 0;
    num_indices = 0;
    patched = false;
    patched2 = false;
    let at = pi * tp.record + tp.factor_at;
    let a = bitcast<vec4<f32>>(hull[at]);
    let b = bitcast<vec4<f32>>(hull[at + 1u]);
    var f = array<f32, 6>(a.x, a.y, a.z, a.w, b.x, b.y);
    if (tp.domain == 3u) { tessellate_quad(f); }
    else if (tp.domain == 2u) { tessellate_tri(f); }
    else { tessellate_isoline(f[0], f[1]); }
}

@compute @workgroup_size(64) fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pi = gid.x + gid.y * 65535u * 64u;
    if (pi >= tp.patches) { return; }
    writing = false;
    tessellate(pi);
    counts[pi] = vec2<u32>(u32(num_points), u32(num_indices));
}

@compute @workgroup_size(1) fn scan() {
    var total = vec2<u32>(0u, 0u);
    for (var pi = 0u; pi < tp.patches; pi++) {
        offsets[pi] = total;
        total += counts[pi];
    }
    // (past the room: as many as fit)
    total = min(total, vec2<u32>(tp.max_points, tp.max_indices));
    let groups = (total.x + 63u) / 64u;
    args[0] = min(groups, 65535u);
    args[1] = (groups + 65534u) / 65535u;
    args[2] = 1u;
    args[3] = total.y;
    args[4] = 1u;
    args[5] = 0u;
    args[6] = 0u;
    args[7] = total.x;
}

@compute @workgroup_size(64) fn generate(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pi = gid.x + gid.y * 65535u * 64u;
    if (pi >= tp.patches) { return; }
    writing = true;
    point_base = offsets[pi].x;
    index_base = offsets[pi].y;
    tessellate(pi);
}
`;

    const exports = { TESSELLATOR_WGSL };
    if (typeof module === "object" && module.exports) module.exports = exports;
    else global.V86TessellatorWGSL = exports;
})(typeof globalThis !== "undefined" ? globalThis : this);
