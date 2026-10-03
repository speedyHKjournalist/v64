// The format table GX (src/browser/glbridge/gx/gx_executor.js) gets, built
// from the device's own tables so the two agree: per SVGA3dSurfaceFormat,
// [WebGPU texture format, what it can do, WebGPU vertex format, block
// width, block height, bytes per block]. tools/build_glbridge.mjs puts it in
// the bundle as globalThis.V86SVGADXFormats; tests import it.

import * as C from "../src/graphics_adapters/vmware_svga/svga_constants.js";
import { DX_FORMATS } from "../src/graphics_adapters/vmware_svga/svga_dx_formats.js";
import { SURFACE_DESCS } from "../src/graphics_adapters/vmware_svga/svga_formats.js";

export function gx_formats()
{
    const table = [];
    for(let format = 0; format < C.SVGA3D_FORMAT_MAX; format++)
    {
        const desc = SURFACE_DESCS[format];
        table.push(["", "", "", desc[1] || 1, desc[2] || 1, desc[4] || 0]);
    }
    for(const [name, [texture, can, vertex]] of Object.entries(DX_FORMATS))
    {
        const format = C[name];
        if(format === undefined) throw new Error("svga_dx_formats.js names an unknown format " + name);
        table[format][0] = texture;
        table[format][1] = can;
        table[format][2] = vertex;
    }
    return table;
}
