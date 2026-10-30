// Shared column-major GL matrix operations for CPU state and rendering.
(function(global) {
    "use strict";
    function identity4(out) {
        const m = out || new Float32Array(16);
        m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
        m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
        m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
        m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
        return m;
    }

    function multiply4(a, b, out) {
        const m = out || new Float32Array(16);
        for (let c = 0; c < 4; ++c) {
            const b0 = b[c * 4], b1 = b[c * 4 + 1];
            const b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
            m[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
            m[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
            m[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            m[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return m;
    }

    function invert4(m, out) {
        const inv = out || new Float32Array(16);
        const a = m;
        inv[0] = a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] +
                 a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
        inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] -
                 a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
        inv[8] = a[4]*a[9]*a[15] - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] +
                 a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
        inv[12] = -a[4]*a[9]*a[14] + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] -
                  a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
        inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] -
                 a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
        inv[5] = a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] +
                 a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
        inv[9] = -a[0]*a[9]*a[15] + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] -
                 a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
        inv[13] = a[0]*a[9]*a[14] - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] +
                  a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
        inv[2] = a[1]*a[6]*a[15] - a[1]*a[7]*a[14] - a[5]*a[2]*a[15] +
                 a[5]*a[3]*a[14] + a[13]*a[2]*a[7] - a[13]*a[3]*a[6];
        inv[6] = -a[0]*a[6]*a[15] + a[0]*a[7]*a[14] + a[4]*a[2]*a[15] -
                 a[4]*a[3]*a[14] - a[12]*a[2]*a[7] + a[12]*a[3]*a[6];
        inv[10] = a[0]*a[5]*a[15] - a[0]*a[7]*a[13] - a[4]*a[1]*a[15] +
                  a[4]*a[3]*a[13] + a[12]*a[1]*a[7] - a[12]*a[3]*a[5];
        inv[14] = -a[0]*a[5]*a[14] + a[0]*a[6]*a[13] + a[4]*a[1]*a[14] -
                  a[4]*a[2]*a[13] - a[12]*a[1]*a[6] + a[12]*a[2]*a[5];
        inv[3] = -a[1]*a[6]*a[11] + a[1]*a[7]*a[10] + a[5]*a[2]*a[11] -
                 a[5]*a[3]*a[10] - a[9]*a[2]*a[7] + a[9]*a[3]*a[6];
        inv[7] = a[0]*a[6]*a[11] - a[0]*a[7]*a[10] - a[4]*a[2]*a[11] +
                 a[4]*a[3]*a[10] + a[8]*a[2]*a[7] - a[8]*a[3]*a[6];
        inv[11] = -a[0]*a[5]*a[11] + a[0]*a[7]*a[9] + a[4]*a[1]*a[11] -
                  a[4]*a[3]*a[9] - a[8]*a[1]*a[7] + a[8]*a[3]*a[5];
        inv[15] = a[0]*a[5]*a[10] - a[0]*a[6]*a[9] - a[4]*a[1]*a[10] +
                  a[4]*a[2]*a[9] + a[8]*a[1]*a[6] - a[8]*a[2]*a[5];
        let det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12];
        if (det === 0) return identity4(inv);
        det = 1.0 / det;
        for (let i = 0; i < 16; ++i) inv[i] *= det;
        return inv;
    }

    function transpose4(m, out) {
        const t = out || new Float32Array(16);
        for (let c = 0; c < 4; ++c)
            for (let r = 0; r < 4; ++r)
                t[r * 4 + c] = m[c * 4 + r];
        return t;
    }

    /* gl_NormalMatrix is the inverse transpose of the modelview's upper 3x3. */
    function normalMatrixOf(modelview, out) {
        const n = out || new Float32Array(9);
        const a = modelview;
        const m00 = a[0], m01 = a[4], m02 = a[8];
        const m10 = a[1], m11 = a[5], m12 = a[9];
        const m20 = a[2], m21 = a[6], m22 = a[10];
        const c00 = m11 * m22 - m12 * m21;
        const c01 = m12 * m20 - m10 * m22;
        const c02 = m10 * m21 - m11 * m20;
        let det = m00 * c00 + m01 * c01 + m02 * c02;
        if (det === 0) {
            n[0] = 1; n[1] = 0; n[2] = 0;
            n[3] = 0; n[4] = 1; n[5] = 0;
            n[6] = 0; n[7] = 0; n[8] = 1;
            return n;
        }
        det = 1 / det;
        // The inverse transpose is the cofactor matrix over the determinant:
        // element (r, c) is cofactor (r, c), stored column-major at c * 3 + r
        // (review S2-1: these were the inverse's, the cofactors transposed)
        n[0] = c00 * det;
        n[1] = (m02 * m21 - m01 * m22) * det;
        n[2] = (m01 * m12 - m02 * m11) * det;
        n[3] = c01 * det;
        n[4] = (m00 * m22 - m02 * m20) * det;
        n[5] = (m02 * m10 - m00 * m12) * det;
        n[6] = c02 * det;
        n[7] = (m01 * m20 - m00 * m21) * det;
        n[8] = (m00 * m11 - m01 * m10) * det;
        return n;
    }

    function transformPoint4(m, v, out) {
        const o = out || new Float32Array(4);
        o[0] = m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3];
        o[1] = m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3];
        o[2] = m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3];
        o[3] = m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3];
        return o;
    }

    const api = { identity4, multiply4, invert4, transpose4, normalMatrixOf, transformPoint4 };
    global.GLMath = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
