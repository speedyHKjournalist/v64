// The D3D11 fixed-function tessellator: from a patch's tess factors, the
// domain points (u, v) and the primitives over them, exactly as D3D11
// hardware makes them. A port of Microsoft's reference (CHWTessellator in
// tessellator.cpp, MIT licensed, as Mesa carries it in
// src/gallium/auxiliary/tessellator): fixed-point 16.16 arithmetic, the
// ruler-function stitching of rows with different tess factors.
//
// GX runs the same algorithm on the GPU (tessellator.wgsl.js mirrors this
// file function by function); this one is the reference its tests compare
// with.
//
//   tessellate({ domain, partitioning, primitive, factors })
//     domain: 1 isoline, 2 tri, 3 quad (D3D11_SB_TESSELLATOR_DOMAIN)
//     partitioning: 1 integer, 2 pow2, 3 fractional_odd, 4 fractional_even
//     primitive: 1 point, 2 line, 3 triangle_cw, 4 triangle_ccw
//     factors: quad [Ueq0, Veq0, Ueq1, Veq1, insideU, insideV];
//              tri [Ueq0, Veq0, Weq0, inside]; isoline [density, detail]
//   -> { points: Float32Array of (u, v) pairs, indices: Int32Array }
(function(global) {
    "use strict";

    const PARTITIONING = { INTEGER: 1, POW2: 2, FRACTIONAL_ODD: 3, FRACTIONAL_EVEN: 4 };
    const PRIMITIVE = { POINT: 1, LINE: 2, TRIANGLE_CW: 3, TRIANGLE_CCW: 4 };
    const DOMAIN = { ISOLINE: 1, TRI: 2, QUAD: 3 };
    const EVEN = 0, ODD = 1;

    const FXP_FRACTION_BITS = 16, FXP_FRACTION_MASK = 0x0000ffff, FXP_INTEGER_MASK = 0x7fff0000;
    const FXP_ONE = 1 << FXP_FRACTION_BITS, FXP_ONE_THIRD = 0x00005555, FXP_TWO_THIRDS = 0x0000aaaa, FXP_ONE_HALF = 0x00008000;
    const MIN_ODD = 1, MAX_ODD = 63, MIN_EVEN = 2, MAX_EVEN = 64, MIN_DENSITY = 1, MAX_DENSITY = 64;
    const EPSILON = 0.0000152587890625;
    const MIN_ODD_PLUS_HALF_EPSILON = MIN_ODD + EPSILON / 2;

    const RECIPROCAL = [
        0xffffffff,
        0x10000, 0x8000, 0x5555, 0x4000, 0x3333, 0x2aab, 0x2492, 0x2000, 0x1c72, 0x199a, 0x1746, 0x1555, 0x13b1, 0x1249, 0x1111, 0x1000,
        0xf0f, 0xe39, 0xd79, 0xccd, 0xc31, 0xba3, 0xb21, 0xaab, 0xa3d, 0x9d9, 0x97b, 0x925, 0x8d4, 0x889, 0x842, 0x800,
        0x7c2, 0x788, 0x750, 0x71c, 0x6eb, 0x6bd, 0x690, 0x666, 0x63e, 0x618, 0x5f4, 0x5d1, 0x5b0, 0x591, 0x572, 0x555,
        0x539, 0x51f, 0x505, 0x4ec, 0x4d5, 0x4be, 0x4a8, 0x492, 0x47e, 0x46a, 0x457, 0x444, 0x432, 0x421, 0x410, 0x400,
    ];
    const FINAL_POINT_POSITION = [0, 32, 16, 8, 17, 4, 18, 9, 19, 2, 20, 10, 21, 5, 22, 11, 23,
        1, 24, 12, 25, 6, 26, 13, 27, 3, 28, 14, 29, 7, 30, 15, 31];
    const LOOP_START = [1, 1, 17, 9, 9, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
    const LOOP_END = [0, 0, 17, 17, 25, 25, 25, 25, 29, 29, 29, 29, 29, 29, 29, 29, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 32];
    const DIAGONALS_INSIDE_TO_OUTSIDE = 0, DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE = 1, DIAGONALS_MIRRORED = 2;

    const f32 = Math.fround;

    /** IEEE 754 float to unsigned 15.16, round to nearest even (floatToIDotF) */
    function floatToFixed(x) {
        x = f32(x);
        if (Number.isNaN(x) || x <= 0) return 0;
        if (x >= 32768) return 0x7fffffff;
        const scaled = x * 65536;
        let r = Math.floor(scaled);
        const fraction = scaled - r;
        if (fraction > 0.5 || (fraction === 0.5 && (r & 1))) r++;
        return r >>> 0;
    }

    function fixedToFloat(x) {
        return f32((x >>> FXP_FRACTION_BITS) + (x & FXP_FRACTION_MASK) / (1 << FXP_FRACTION_BITS));
    }

    const isEven = x => !((x | 0) & 1);
    const fxpCeil = x => (x & FXP_FRACTION_MASK) ? ((x & FXP_INTEGER_MASK) + FXP_ONE) >>> 0 : x;
    const fxpFloor = x => (x & FXP_INTEGER_MASK) >>> 0;
    // IEEE 754R min and max: NaN in the second operand loses
    const fmin = (a, b) => Number.isNaN(b) ? a : (a < b ? a : b);
    const fmax = (a, b) => Number.isNaN(b) ? a : (a > b ? a : b);

    function removeMSB(val) {
        let check;
        if (val <= 0x0000ffff) check = val <= 0x000000ff ? 0x00000080 : 0x00008000;
        else check = val <= 0x00ffffff ? 0x00800000 : 0x80000000;
        for (let i = 0; i < 8; i++, check >>>= 1) if (val & check) return val & ~check;
        return 0;
    }

    class Tessellator {
        constructor(partitioning, primitive) {
            this.partitioning = this.originalPartitioning = partitioning;
            this.parity = this.originalParity = partitioning === PARTITIONING.FRACTIONAL_ODD ? ODD : EVEN;
            this.primitive = primitive;
            this.points = [];
            this.indices = [];
            this.numPoints = 0;
            this.numIndices = 0;
            this.patched = false;
            this.patched2 = false;
            this.ctx = {};
            this.ctx2 = {};
        }

        odd() { return this.parity === ODD; }
        hwInteger() { return this.partitioning === PARTITIONING.INTEGER || this.partitioning === PARTITIONING.POW2; }

        definePoint(u, v, offset) {
            this.points[offset * 2] = fixedToFloat(u);
            this.points[offset * 2 + 1] = fixedToFloat(v);
        }

        defineIndex(index, offset) {
            this.indices[offset] = this.patchIndexValue(index);
        }

        defineClockwiseTriangle(i0, i1, i2, base) {
            this.defineIndex(i0, base);
            if (this.primitive === PRIMITIVE.TRIANGLE_CW) {
                this.defineIndex(i1, base + 1);
                this.defineIndex(i2, base + 2);
            } else {
                this.defineIndex(i2, base + 1);
                this.defineIndex(i1, base + 2);
            }
        }

        dumpAllPoints() {
            for (let p = 0; p < this.numPoints; p++) this.defineIndex(p, this.numIndices++);
        }

        dumpAllPointsAsInOrderLineList() {
            for (let p = 1; p < this.numPoints; p++) {
                this.defineIndex(p - 1, this.numIndices++);
                this.defineIndex(p, this.numIndices++);
            }
        }

        numPointsForTessFactor(fxp) {
            if (this.odd()) return (fxpCeil(FXP_ONE_HALF + ((fxp + 1) >>> 1)) * 2) >>> FXP_FRACTION_BITS;
            return ((fxpCeil((fxp + 1) >>> 1) * 2) >>> FXP_FRACTION_BITS) + 1;
        }

        computeTessFactorContext(fxp) {
            const ctx = {};
            let half = (fxp + 1) >>> 1;
            if (this.odd() || half === FXP_ONE_HALF) half += FXP_ONE_HALF;
            const floorHalf = fxpFloor(half), ceilHalf = fxpCeil(half);
            ctx.halfTessFactorFraction = half - floorHalf;
            ctx.numHalfTessFactorPoints = ceilHalf >>> FXP_FRACTION_BITS;
            if (ceilHalf === floorHalf) {
                ctx.splitPointOnFloorHalfTessFactor = ctx.numHalfTessFactorPoints + 1;
            } else if (this.odd()) {
                ctx.splitPointOnFloorHalfTessFactor = floorHalf === FXP_ONE ? 0 : (removeMSB((floorHalf >>> FXP_FRACTION_BITS) - 1) << 1) + 1;
            } else {
                ctx.splitPointOnFloorHalfTessFactor = (removeMSB(floorHalf >>> FXP_FRACTION_BITS) << 1) + 1;
            }
            let floorSegments = (floorHalf * 2) >>> FXP_FRACTION_BITS;
            let ceilSegments = (ceilHalf * 2) >>> FXP_FRACTION_BITS;
            if (this.odd()) { floorSegments--; ceilSegments--; }
            ctx.invNumSegmentsOnFloorTessFactor = RECIPROCAL[floorSegments];
            ctx.invNumSegmentsOnCeilTessFactor = RECIPROCAL[ceilSegments];
            return ctx;
        }

        placePointIn1D(ctx, point) {
            let flip = false;
            if (point >= ctx.numHalfTessFactorPoints) {
                point = (ctx.numHalfTessFactorPoints << 1) - point;
                if (this.odd()) point--;
                flip = true;
            }
            if (point === ctx.numHalfTessFactorPoints) return FXP_ONE_HALF;
            const onCeil = point;
            let onFloor = onCeil;
            if (point > ctx.splitPointOnFloorHalfTessFactor) onFloor--;
            const locFloor = onFloor * ctx.invNumSegmentsOnFloorTessFactor;
            const locCeil = onCeil * ctx.invNumSegmentsOnCeilTessFactor;
            let location = locFloor * (FXP_ONE - ctx.halfTessFactorFraction) + locCeil * ctx.halfTessFactorFraction;
            location = Math.floor((location + FXP_ONE_HALF) / 65536);
            return flip ? FXP_ONE - location : location;
        }

        patchIndexValue(index) {
            if (this.patched) {
                const c = this.ctx;
                if (index >= c.outsidePointIndexPatchBase) {
                    index = index === c.outsidePointIndexBadValue ? c.outsidePointIndexReplacementValue : index + c.outsidePointIndexDeltaToRealValue;
                } else {
                    index = index === c.insidePointIndexBadValue ? c.insidePointIndexReplacementValue : index + c.insidePointIndexDeltaToRealValue;
                }
            } else if (this.patched2) {
                const c = this.ctx2;
                if (index >= c.baseIndexToInvert) {
                    index = index === c.cornerCaseBadValue ? c.cornerCaseReplacementValue : c.indexInversionEndPoint - index;
                } else if (index === c.cornerCaseBadValue) {
                    index = c.cornerCaseReplacementValue;
                }
            }
            return index;
        }

        stitchRegular(trapezoid, diagonals, base, numInsideEdgePoints, insideBase, outsideBase) {
            let inside = insideBase, outside = outsideBase;
            if (trapezoid) {
                this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                base += 3; outside++;
            }
            let p;
            switch (diagonals) {
                case DIAGONALS_INSIDE_TO_OUTSIDE:
                    for (p = 0; p < numInsideEdgePoints - 1; p++) {
                        this.defineClockwiseTriangle(inside, outside, outside + 1, base); base += 3;
                        this.defineClockwiseTriangle(inside, outside + 1, inside + 1, base); base += 3;
                        inside++; outside++;
                    }
                    break;
                case DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE:
                    for (p = 0; p < (numInsideEdgePoints >> 1) - 1; p++) {
                        this.defineClockwiseTriangle(outside, outside + 1, inside, base); base += 3;
                        this.defineClockwiseTriangle(inside, outside + 1, inside + 1, base); base += 3;
                        inside++; outside++;
                    }
                    this.defineClockwiseTriangle(outside, inside + 1, inside, base); base += 3;
                    this.defineClockwiseTriangle(outside, outside + 1, inside + 1, base); base += 3;
                    inside++; outside++; p += 2;
                    for (; p < numInsideEdgePoints; p++) {
                        this.defineClockwiseTriangle(outside, outside + 1, inside, base); base += 3;
                        this.defineClockwiseTriangle(inside, outside + 1, inside + 1, base); base += 3;
                        inside++; outside++;
                    }
                    break;
                case DIAGONALS_MIRRORED:
                    for (p = 0; p < (numInsideEdgePoints >> 1); p++) {
                        this.defineClockwiseTriangle(outside, inside + 1, inside, base); base += 3;
                        this.defineClockwiseTriangle(outside, outside + 1, inside + 1, base); base += 3;
                        inside++; outside++;
                    }
                    for (; p < numInsideEdgePoints - 1; p++) {
                        this.defineClockwiseTriangle(inside, outside, outside + 1, base); base += 3;
                        this.defineClockwiseTriangle(inside, outside + 1, inside + 1, base); base += 3;
                        inside++; outside++;
                    }
                    break;
            }
            if (trapezoid) {
                this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                base += 3;
            }
        }

        stitchTransition(base, insideBase, insideHalf, insideParity, outsideBase, outsideHalf, outsideParity) {
            if (insideParity === ODD) insideHalf--;
            if (outsideParity === ODD) outsideHalf--;
            let outside = outsideBase, inside = insideBase;
            const start = Math.min(LOOP_START[insideHalf], LOOP_START[outsideHalf]);
            const end = Math.max(LOOP_END[insideHalf], LOOP_END[outsideHalf]);
            if (FINAL_POINT_POSITION[0] < outsideHalf) {
                this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                base += 3; outside++;
            }
            for (let i = start; i <= end; i++) {
                if (FINAL_POINT_POSITION[i] < insideHalf) {
                    this.defineClockwiseTriangle(inside, outside, inside + 1, base);
                    base += 3; inside++;
                }
                if (FINAL_POINT_POSITION[i] < outsideHalf) {
                    this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                    base += 3; outside++;
                }
            }
            if (insideParity !== outsideParity || insideParity === ODD) {
                if (insideParity === outsideParity) {
                    this.defineClockwiseTriangle(inside, outside, inside + 1, base); base += 3;
                    this.defineClockwiseTriangle(inside + 1, outside, outside + 1, base); base += 3;
                    inside++; outside++;
                } else if (insideParity === EVEN) {
                    this.defineClockwiseTriangle(inside, outside, outside + 1, base); base += 3;
                    outside++;
                } else {
                    this.defineClockwiseTriangle(inside, outside, inside + 1, base); base += 3;
                    inside++;
                }
            }
            for (let i = end; i >= start; i--) {
                if (FINAL_POINT_POSITION[i] < outsideHalf) {
                    this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                    base += 3; outside++;
                }
                if (FINAL_POINT_POSITION[i] < insideHalf) {
                    this.defineClockwiseTriangle(inside, outside, inside + 1, base);
                    base += 3; inside++;
                }
            }
            if (FINAL_POINT_POSITION[0] < outsideHalf) {
                this.defineClockwiseTriangle(outside, outside + 1, inside, base);
                base += 3; outside++;
            }
        }

        /** The bounds of the partitioning's tess factors */
        bounds() {
            switch (this.originalPartitioning) {
                case PARTITIONING.FRACTIONAL_EVEN: return [MIN_EVEN, MAX_EVEN];
                case PARTITIONING.FRACTIONAL_ODD: return [MIN_ODD, MAX_ODD];
                default: return [MIN_ODD, MAX_EVEN];
            }
        }

        // -------------------------------------------------------------- quad

        tessellateQuad(Ueq0, Veq0, Ueq1, Veq1, insideU, insideV) {
            const pf = this.quadProcess(f32(Ueq0), f32(Veq0), f32(Ueq1), f32(Veq1), f32(insideU), f32(insideV));
            if (pf.culled) { this.numPoints = 0; this.numIndices = 0; return; }
            if (pf.minimum) {
                this.definePoint(0, 0, 0);
                this.definePoint(FXP_ONE, 0, 1);
                this.definePoint(FXP_ONE, FXP_ONE, 2);
                this.definePoint(0, FXP_ONE, 3);
                this.numPoints = 4;
                if (this.primitive === PRIMITIVE.TRIANGLE_CW || this.primitive === PRIMITIVE.TRIANGLE_CCW) {
                    this.defineClockwiseTriangle(0, 1, 3, 0);
                    this.defineClockwiseTriangle(1, 2, 3, 3);
                    this.numIndices = 6;
                } else if (this.primitive === PRIMITIVE.POINT) {
                    this.dumpAllPoints();
                } else {
                    this.dumpAllPointsAsInOrderLineList();
                }
                return;
            }
            this.quadGeneratePoints(pf);
            if (this.primitive === PRIMITIVE.POINT) return this.dumpAllPoints();
            if (this.primitive === PRIMITIVE.LINE) return this.dumpAllPointsAsInOrderLineList();
            this.quadGenerateConnectivity(pf);
        }

        quadProcess(Ueq0, Veq0, Ueq1, Veq1, insideU, insideV) {
            const pf = { culled: false, minimum: false };
            if (!(Ueq0 > 0) || !(Veq0 > 0) || !(Ueq1 > 0) || !(Veq1 > 0)) { pf.culled = true; return pf; }
            let [lower, upper] = this.bounds();
            const clamp = x => f32(fmin(upper, fmax(lower, x)));
            Ueq0 = clamp(Ueq0); Veq0 = clamp(Veq0); Ueq1 = clamp(Ueq1); Veq1 = clamp(Veq1);
            if (this.hwInteger()) { Ueq0 = Math.ceil(Ueq0); Veq0 = Math.ceil(Veq0); Ueq1 = Math.ceil(Ueq1); Veq1 = Math.ceil(Veq1); }
            if (this.originalPartitioning === PARTITIONING.FRACTIONAL_ODD) {
                if (Ueq0 > MIN_ODD_PLUS_HALF_EPSILON || Veq0 > MIN_ODD_PLUS_HALF_EPSILON || Ueq1 > MIN_ODD_PLUS_HALF_EPSILON ||
                    Veq1 > MIN_ODD_PLUS_HALF_EPSILON || insideU > MIN_ODD_PLUS_HALF_EPSILON || insideV > MIN_ODD_PLUS_HALF_EPSILON) {
                    lower = f32(MIN_ODD + EPSILON);
                }
            }
            insideU = clamp(insideU); insideV = clamp(insideV);
            if (this.hwInteger()) { insideU = Math.ceil(insideU); insideV = Math.ceil(insideV); }
            this.numPoints = 0;
            this.numIndices = 0;
            const outside = [Ueq0, Veq0, Ueq1, Veq1], inside = [insideU, insideV];
            pf.outsideParity = []; pf.insideParity = [];
            if (this.hwInteger()) {
                for (let e = 0; e < 4; e++) pf.outsideParity[e] = isEven(outside[e]) ? EVEN : ODD;
                for (let a = 0; a < 2; a++) pf.insideParity[a] = isEven(inside[a]) || inside[a] === 1 ? EVEN : ODD;
            } else {
                for (let e = 0; e < 4; e++) pf.outsideParity[e] = this.originalParity;
                pf.insideParity[0] = pf.insideParity[1] = this.originalParity;
            }
            pf.outside = outside.map(floatToFixed);
            pf.inside = inside.map(floatToFixed);
            if (this.hwInteger() || this.odd()) {
                if (pf.inside[0] === FXP_ONE && pf.inside[1] === FXP_ONE && pf.outside.every(x => x === FXP_ONE)) {
                    pf.minimum = true;
                    return pf;
                }
            }
            pf.outsideCtx = []; pf.insideCtx = [];
            for (let e = 0; e < 4; e++) { this.parity = pf.outsideParity[e]; pf.outsideCtx[e] = this.computeTessFactorContext(pf.outside[e]); }
            for (let a = 0; a < 2; a++) { this.parity = pf.insideParity[a]; pf.insideCtx[a] = this.computeTessFactorContext(pf.inside[a]); }
            pf.numPointsForOutsideEdge = [];
            for (let e = 0; e < 4; e++) {
                this.parity = pf.outsideParity[e];
                pf.numPointsForOutsideEdge[e] = this.numPointsForTessFactor(pf.outside[e]);
                this.numPoints += pf.numPointsForOutsideEdge[e];
            }
            this.numPoints -= 4;
            pf.numPointsForInside = [];
            for (let a = 0; a < 2; a++) {
                this.parity = pf.insideParity[a];
                const min = pf.insideParity[a] === ODD ? 4 : 3;
                pf.numPointsForInside[a] = Math.max(min, this.numPointsForTessFactor(pf.inside[a]));
            }
            pf.insideEdgePointBaseOffset = this.numPoints;
            this.numPoints += (pf.numPointsForInside[0] - 2) * (pf.numPointsForInside[1] - 2);
            return pf;
        }

        quadGeneratePoints(pf) {
            let offset = 0;
            for (let edge = 0; edge < 4; edge++) {
                const parity = edge & 1;
                const end = pf.numPointsForOutsideEdge[edge] - 1;
                for (let p = 0; p < end; p++, offset++) {
                    const q = edge === 1 || edge === 2 ? p : end - p;
                    this.parity = pf.outsideParity[edge];
                    const param = this.placePointIn1D(pf.outsideCtx[edge], q);
                    if (parity) this.definePoint(param, edge === 3 ? FXP_ONE : 0, offset);
                    else this.definePoint(edge === 2 ? FXP_ONE : 0, param, offset);
                }
            }
            const minPoints = Math.min(pf.numPointsForInside[0], pf.numPointsForInside[1]);
            const numRings = minPoints >> 1;
            for (let ring = 1; ring < numRings; ring++) {
                const start = ring;
                const end = [pf.numPointsForInside[0] - 1 - start, pf.numPointsForInside[1] - 1 - start];
                for (let edge = 0; edge < 4; edge++) {
                    const parity = [edge & 1, (edge + 1) & 1];
                    const perpPoint = edge < 2 ? start : end[parity[0]];
                    this.parity = pf.insideParity[parity[0]];
                    const perp = this.placePointIn1D(pf.insideCtx[parity[0]], perpPoint);
                    this.parity = pf.insideParity[parity[1]];
                    for (let p = start; p < end[parity[1]]; p++, offset++) {
                        const q = edge === 1 || edge === 2 ? p : end[parity[1]] - (p - start);
                        const param = this.placePointIn1D(pf.insideCtx[parity[1]], q);
                        if (parity[1]) this.definePoint(perp, param, offset);
                        else this.definePoint(param, perp, offset);
                    }
                }
            }
            if (pf.numPointsForInside[0] > pf.numPointsForInside[1] && pf.insideParity[1] === EVEN) {
                const start = numRings, end = pf.numPointsForInside[0] - 1 - start;
                this.parity = pf.insideParity[0];
                for (let p = start; p <= end; p++, offset++) {
                    this.definePoint(this.placePointIn1D(pf.insideCtx[0], p), FXP_ONE_HALF, offset);
                }
            } else if (pf.numPointsForInside[1] >= pf.numPointsForInside[0] && pf.insideParity[0] === EVEN) {
                const start = numRings, end = pf.numPointsForInside[1] - 1 - start;
                this.parity = pf.insideParity[1];
                for (let p = end; p >= start; p--, offset++) {
                    this.definePoint(FXP_ONE_HALF, this.placePointIn1D(pf.insideCtx[1], p), offset);
                }
            }
        }

        quadGenerateConnectivity(pf) {
            const rowsToCenter = [(pf.numPointsForInside[0] + 1) >> 1, (pf.numPointsForInside[1] + 1) >> 1];
            const numRings = Math.min(rowsToCenter[0], rowsToCenter[1]);
            const degenerateRing = [pf.insideParity[1] === EVEN ? rowsToCenter[1] - 1 : -1, pf.insideParity[0] === EVEN ? rowsToCenter[0] - 1 : -1];
            const outsideCtx = pf.outsideCtx.slice(), outsideParity = pf.outsideParity.slice(), numPointsForOutsideEdge = pf.numPointsForOutsideEdge.slice();
            let insideEdgeBase = pf.insideEdgePointBaseOffset, outsideEdgeBase = 0;
            for (let ring = 1; ring < numRings; ring++) {
                const numInside = [pf.numPointsForInside[0] - 2 * ring, pf.numPointsForInside[1] - 2 * ring];
                const edge0InsideBase = insideEdgeBase, edge0OutsideBase = outsideEdgeBase;
                for (let edge = 0; edge < 4; edge++) {
                    const parity = (edge + 1) & 1;
                    const numTriangles = numInside[parity] + numPointsForOutsideEdge[edge] - 2;
                    let insideBase, outsideBase;
                    if (edge === 3) {
                        if (ring === degenerateRing[parity]) {
                            const c = this.ctx2;
                            c.baseIndexToInvert = insideEdgeBase + 1;
                            c.cornerCaseBadValue = outsideEdgeBase + numPointsForOutsideEdge[edge] - 1;
                            c.cornerCaseReplacementValue = edge0OutsideBase;
                            c.indexInversionEndPoint = (c.baseIndexToInvert << 1) - 1;
                            insideBase = c.baseIndexToInvert;
                            outsideBase = outsideEdgeBase;
                            this.patched2 = true;
                        } else {
                            const c = this.ctx;
                            c.insidePointIndexDeltaToRealValue = insideEdgeBase;
                            c.insidePointIndexBadValue = numInside[parity] - 1;
                            c.insidePointIndexReplacementValue = edge0InsideBase;
                            c.outsidePointIndexPatchBase = c.insidePointIndexBadValue + 1;
                            c.outsidePointIndexDeltaToRealValue = outsideEdgeBase - c.outsidePointIndexPatchBase;
                            c.outsidePointIndexBadValue = c.outsidePointIndexPatchBase + numPointsForOutsideEdge[edge] - 1;
                            c.outsidePointIndexReplacementValue = edge0OutsideBase;
                            insideBase = 0;
                            outsideBase = c.outsidePointIndexPatchBase;
                            this.patched = true;
                        }
                    } else if (edge === 2 && ring === degenerateRing[parity]) {
                        const c = this.ctx2;
                        c.baseIndexToInvert = insideEdgeBase;
                        c.cornerCaseBadValue = -1;
                        c.cornerCaseReplacementValue = -1;
                        c.indexInversionEndPoint = c.baseIndexToInvert << 1;
                        insideBase = c.baseIndexToInvert;
                        outsideBase = outsideEdgeBase;
                        this.patched2 = true;
                    } else {
                        insideBase = insideEdgeBase;
                        outsideBase = outsideEdgeBase;
                    }
                    if (ring === 1) {
                        this.stitchTransition(this.numIndices, insideBase, pf.insideCtx[parity].numHalfTessFactorPoints, pf.insideParity[parity],
                            outsideBase, outsideCtx[edge].numHalfTessFactorPoints, outsideParity[edge]);
                    } else {
                        this.stitchRegular(true, DIAGONALS_MIRRORED, this.numIndices, numInside[parity], insideBase, outsideBase);
                    }
                    this.patched = false;
                    this.patched2 = false;
                    this.numIndices += numTriangles * 3;
                    outsideEdgeBase += numPointsForOutsideEdge[edge] - 1;
                    if (edge === 2 && ring === degenerateRing[parity]) insideEdgeBase -= numInside[parity] - 1;
                    else insideEdgeBase += numInside[parity] - 1;
                    numPointsForOutsideEdge[edge] = numInside[parity];
                }
                if (ring === 1) {
                    for (let edge = 0; edge < 4; edge++) {
                        outsideCtx[edge] = pf.insideCtx[edge & 1];
                        outsideParity[edge] = pf.insideParity[edge & 1];
                    }
                }
            }
            if (pf.numPointsForInside[0] > pf.numPointsForInside[1] && pf.insideParity[1] === ODD) {
                this.patched2 = true;
                const quads = (((pf.numPointsForInside[0] >> 1) - (pf.numPointsForInside[1] >> 1)) << 1) + (pf.insideParity[0] === EVEN ? 2 : 1);
                const c = this.ctx2;
                c.baseIndexToInvert = outsideEdgeBase + quads + 2;
                c.cornerCaseBadValue = c.baseIndexToInvert;
                c.cornerCaseReplacementValue = outsideEdgeBase;
                c.indexInversionEndPoint = c.baseIndexToInvert + c.baseIndexToInvert + quads;
                this.stitchRegular(false, DIAGONALS_INSIDE_TO_OUTSIDE, this.numIndices, quads + 1, c.baseIndexToInvert, outsideEdgeBase + 1);
                this.patched2 = false;
                this.numIndices += quads * 6;
            } else if (pf.numPointsForInside[1] >= pf.numPointsForInside[0] && pf.insideParity[0] === ODD) {
                this.patched2 = true;
                const quads = (((pf.numPointsForInside[1] >> 1) - (pf.numPointsForInside[0] >> 1)) << 1) + (pf.insideParity[1] === EVEN ? 2 : 1);
                const c = this.ctx2;
                c.baseIndexToInvert = outsideEdgeBase + quads + 1;
                c.cornerCaseBadValue = -1;
                c.indexInversionEndPoint = c.baseIndexToInvert + c.baseIndexToInvert + quads;
                const diagonals = pf.insideParity[1] === EVEN ? DIAGONALS_INSIDE_TO_OUTSIDE : DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE;
                this.stitchRegular(false, diagonals, this.numIndices, quads + 1, c.baseIndexToInvert, outsideEdgeBase);
                this.patched2 = false;
                this.numIndices += quads * 6;
            }
        }

        // --------------------------------------------------------------- tri

        tessellateTri(Ueq0, Veq0, Weq0, inside) {
            const pf = this.triProcess(f32(Ueq0), f32(Veq0), f32(Weq0), f32(inside));
            if (pf.culled) { this.numPoints = 0; this.numIndices = 0; return; }
            if (pf.minimum) {
                this.definePoint(0, FXP_ONE, 0);
                this.definePoint(0, 0, 1);
                this.definePoint(FXP_ONE, 0, 2);
                this.numPoints = 3;
                if (this.primitive === PRIMITIVE.TRIANGLE_CW || this.primitive === PRIMITIVE.TRIANGLE_CCW) {
                    this.defineClockwiseTriangle(0, 1, 2, this.numIndices);
                    this.numIndices = 3;
                } else if (this.primitive === PRIMITIVE.POINT) {
                    this.dumpAllPoints();
                } else {
                    this.dumpAllPointsAsInOrderLineList();
                }
                return;
            }
            this.triGeneratePoints(pf);
            if (this.primitive === PRIMITIVE.POINT) return this.dumpAllPoints();
            if (this.primitive === PRIMITIVE.LINE) return this.dumpAllPointsAsInOrderLineList();
            this.triGenerateConnectivity(pf);
        }

        triProcess(Ueq0, Veq0, Weq0, inside) {
            const pf = { culled: false, minimum: false };
            if (!(Ueq0 > 0) || !(Veq0 > 0) || !(Weq0 > 0)) { pf.culled = true; return pf; }
            let [lower, upper] = this.bounds();
            const clamp = x => f32(fmin(upper, fmax(lower, x)));
            Ueq0 = clamp(Ueq0); Veq0 = clamp(Veq0); Weq0 = clamp(Weq0);
            if (this.hwInteger()) { Ueq0 = Math.ceil(Ueq0); Veq0 = Math.ceil(Veq0); Weq0 = Math.ceil(Weq0); }
            if (this.originalPartitioning === PARTITIONING.FRACTIONAL_ODD) {
                if (Ueq0 > MIN_ODD_PLUS_HALF_EPSILON || Veq0 > MIN_ODD_PLUS_HALF_EPSILON || Weq0 > MIN_ODD_PLUS_HALF_EPSILON) {
                    lower = f32(MIN_ODD + EPSILON);
                }
            }
            inside = clamp(inside);
            if (this.hwInteger()) inside = Math.ceil(inside);
            this.numPoints = 0;
            this.numIndices = 0;
            const outside = [Ueq0, Veq0, Weq0];
            pf.outsideParity = [];
            if (this.hwInteger()) {
                for (let e = 0; e < 3; e++) pf.outsideParity[e] = isEven(outside[e]) ? EVEN : ODD;
                pf.insideParity = isEven(inside) || inside === 1 ? EVEN : ODD;
            } else {
                for (let e = 0; e < 3; e++) pf.outsideParity[e] = this.originalParity;
                pf.insideParity = this.originalParity;
            }
            pf.outside = outside.map(floatToFixed);
            pf.inside = floatToFixed(inside);
            if (this.hwInteger() || this.odd()) {
                if (pf.inside === FXP_ONE && pf.outside.every(x => x === FXP_ONE)) { pf.minimum = true; return pf; }
            }
            pf.outsideCtx = [];
            for (let e = 0; e < 3; e++) { this.parity = pf.outsideParity[e]; pf.outsideCtx[e] = this.computeTessFactorContext(pf.outside[e]); }
            this.parity = pf.insideParity;
            pf.insideCtx = this.computeTessFactorContext(pf.inside);
            pf.numPointsForOutsideEdge = [];
            for (let e = 0; e < 3; e++) {
                this.parity = pf.outsideParity[e];
                pf.numPointsForOutsideEdge[e] = this.numPointsForTessFactor(pf.outside[e]);
                this.numPoints += pf.numPointsForOutsideEdge[e];
            }
            this.numPoints -= 3;
            this.parity = pf.insideParity;
            pf.numPointsForInside = Math.max(this.odd() ? 4 : 3, this.numPointsForTessFactor(pf.inside));
            pf.insideEdgePointBaseOffset = this.numPoints;
            const rings = (pf.numPointsForInside >> 1) - 1;
            this.numPoints += this.odd() ? 3 * (rings * (rings + 1) - rings) : 3 * (rings * (rings + 1)) + 1;
            return pf;
        }

        triGeneratePoints(pf) {
            let offset = 0;
            for (let edge = 0; edge < 3; edge++) {
                const parity = edge & 1;
                const end = pf.numPointsForOutsideEdge[edge] - 1;
                for (let p = 0; p < end; p++, offset++) {
                    const q = parity ? p : end - p;
                    this.parity = pf.outsideParity[edge];
                    const param = this.placePointIn1D(pf.outsideCtx[edge], q);
                    if (edge === 0) this.definePoint(0, param, offset);
                    else this.definePoint(param, edge === 2 ? FXP_ONE - param : 0, offset);
                }
            }
            this.parity = pf.insideParity;
            const numRings = pf.numPointsForInside >> 1;
            for (let ring = 1; ring < numRings; ring++) {
                const start = ring, end = pf.numPointsForInside - 1 - start;
                for (let edge = 0; edge < 3; edge++) {
                    const parity = edge & 1;
                    let perp = this.placePointIn1D(pf.insideCtx, start);
                    perp = Math.floor((perp * FXP_TWO_THIRDS + FXP_ONE_HALF) / 65536);
                    for (let p = start; p < end; p++, offset++) {
                        const q = parity ? p : end - (p - start);
                        const param = this.placePointIn1D(pf.insideCtx, q);
                        const shifted = param - ((perp + 1) >>> 1);
                        if (edge === 0) this.definePoint(perp, shifted, offset);
                        else if (edge === 1) this.definePoint(shifted, perp, offset);
                        else this.definePoint(shifted, FXP_ONE - shifted - perp, offset);
                    }
                }
            }
            if (!this.odd()) this.definePoint(FXP_ONE_THIRD, FXP_ONE_THIRD, offset);
        }

        triGenerateConnectivity(pf) {
            const numRings = (pf.numPointsForInside + 1) >> 1;
            const outsideCtx = pf.outsideCtx.slice(), outsideParity = pf.outsideParity.slice(), numPointsForOutsideEdge = pf.numPointsForOutsideEdge.slice();
            let insideEdgeBase = pf.insideEdgePointBaseOffset, outsideEdgeBase = 0;
            for (let ring = 1; ring < numRings; ring++) {
                const numInside = pf.numPointsForInside - 2 * ring;
                const edge0InsideBase = insideEdgeBase, edge0OutsideBase = outsideEdgeBase;
                for (let edge = 0; edge < 3; edge++) {
                    const numTriangles = numInside + numPointsForOutsideEdge[edge] - 2;
                    let insideBase, outsideBase;
                    if (edge === 2) {
                        const c = this.ctx;
                        c.insidePointIndexDeltaToRealValue = insideEdgeBase;
                        c.insidePointIndexBadValue = numInside - 1;
                        c.insidePointIndexReplacementValue = edge0InsideBase;
                        c.outsidePointIndexPatchBase = c.insidePointIndexBadValue + 1;
                        c.outsidePointIndexDeltaToRealValue = outsideEdgeBase - c.outsidePointIndexPatchBase;
                        c.outsidePointIndexBadValue = c.outsidePointIndexPatchBase + numPointsForOutsideEdge[edge] - 1;
                        c.outsidePointIndexReplacementValue = edge0OutsideBase;
                        this.patched = true;
                        insideBase = 0;
                        outsideBase = c.outsidePointIndexPatchBase;
                    } else {
                        insideBase = insideEdgeBase;
                        outsideBase = outsideEdgeBase;
                    }
                    if (ring === 1) {
                        this.stitchTransition(this.numIndices, insideBase, pf.insideCtx.numHalfTessFactorPoints, pf.insideParity,
                            outsideBase, outsideCtx[edge].numHalfTessFactorPoints, outsideParity[edge]);
                    } else {
                        this.stitchRegular(true, DIAGONALS_MIRRORED, this.numIndices, numInside, insideBase, outsideBase);
                    }
                    if (edge === 2) this.patched = false;
                    this.numIndices += numTriangles * 3;
                    outsideEdgeBase += numPointsForOutsideEdge[edge] - 1;
                    insideEdgeBase += numInside - 1;
                    numPointsForOutsideEdge[edge] = numInside;
                }
                if (ring === 1) {
                    for (let edge = 0; edge < 3; edge++) {
                        outsideCtx[edge] = pf.insideCtx;
                        outsideParity[edge] = pf.insideParity;
                    }
                }
            }
            if (this.odd()) {
                this.defineClockwiseTriangle(outsideEdgeBase, outsideEdgeBase + 1, outsideEdgeBase + 2, this.numIndices);
                this.numIndices += 3;
            }
        }

        // ----------------------------------------------------------- isoline

        tessellateIsoLine(density, detail) {
            density = f32(density); detail = f32(detail);
            if (!(density > 0) || !(detail > 0)) { this.numPoints = 0; this.numIndices = 0; return; }
            const [lower, upper] = this.bounds();
            density = f32(fmin(MAX_DENSITY, fmax(MIN_DENSITY, density)));
            detail = f32(fmin(upper, fmax(lower, detail)));
            this.numPoints = 0;
            this.numIndices = 0;
            let detailParity;
            if (this.hwInteger()) {
                detail = Math.ceil(detail);
                detailParity = isEven(detail) ? EVEN : ODD;
            } else {
                detailParity = this.originalParity;
            }
            const fxpDetail = floatToFixed(detail);
            this.parity = detailParity;
            const detailCtx = this.computeTessFactorContext(fxpDetail);
            const pointsPerLine = this.numPointsForTessFactor(fxpDetail);
            this.partitioning = PARTITIONING.INTEGER;
            density = Math.ceil(density);
            const densityParity = isEven(density) ? EVEN : ODD;
            this.parity = densityParity;
            const fxpDensity = floatToFixed(density);
            const densityCtx = this.computeTessFactorContext(fxpDensity);
            const numLines = this.numPointsForTessFactor(fxpDensity) - 1;
            this.partitioning = this.originalPartitioning;
            this.numPoints = pointsPerLine * numLines;
            let offset = 0;
            for (let line = 0; line < numLines; line++) {
                for (let point = 0; point < pointsPerLine; point++) {
                    this.parity = densityParity;
                    const v = this.placePointIn1D(densityCtx, line);
                    this.parity = detailParity;
                    const u = this.placePointIn1D(detailCtx, point);
                    this.definePoint(u, v, offset++);
                }
            }
            offset = 0;
            let index = 0;
            for (let line = 0; line < numLines; line++) {
                for (let point = 0; point < pointsPerLine; point++) {
                    if (this.primitive === PRIMITIVE.POINT) {
                        this.defineIndex(offset, index++);
                    } else if (point > 0) {
                        this.defineIndex(offset - 1, index++);
                        this.defineIndex(offset, index++);
                    }
                    offset++;
                }
            }
            this.numIndices = index;
        }
    }

    function tessellate({ domain, partitioning, primitive, factors }) {
        // (lines and points from tri and quad domains come out as in D3D11's reference)
        const t = new Tessellator(partitioning, primitive);
        if (domain === DOMAIN.QUAD) t.tessellateQuad(...factors);
        else if (domain === DOMAIN.TRI) t.tessellateTri(...factors);
        else t.tessellateIsoLine(factors[0], factors[1]);
        return { points: Float32Array.from(t.points.slice(0, t.numPoints * 2)), indices: Int32Array.from(t.indices.slice(0, t.numIndices)) };
    }

    const exports = { tessellate, PARTITIONING, PRIMITIVE, DOMAIN, floatToFixed };
    if (typeof module === "object" && module.exports) module.exports = exports;
    else global.V86Tessellator = exports;
})(typeof globalThis !== "undefined" ? globalThis : this);
