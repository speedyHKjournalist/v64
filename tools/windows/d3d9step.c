// d3d9step.exe [hw] [depth] [vs] [index] [psvariants] [frames=N]: a D3D9 app that says
// what it is doing, call by call, through the VMware backdoor (RPCI "log",
// which tests/x64/windows_boot.mjs prints as guest-log events), so a hang or
// a failure inside the driver shows which call it was in. The options turn
// on the features one at a time:
//   hw     hardware vertex processing (else software, like the samples)
//   depth  an automatic D24S8 depth buffer, cleared with the target
//   vs     a vs_2_0 and a ps_2_0 that samples a texture (else fixed function)
//   index  an indexed draw from an index buffer
//   psvariants  first, which of a few pixel shaders the driver takes
// It draws a quad for N frames (default 3), then exits.
//
//   x86_64-w64-mingw32-gcc -O2 -mwindows -o D3D9STEP.EXE d3d9step.c -ld3d9
//
// v86 lets user mode use the backdoor port, as VMware does.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <string.h>

#define MAGIC 0x564D5868u
#define PORT 0x5658u
#define MESSAGE 30u

static void backdoor(unsigned *a, unsigned *b, unsigned *c, unsigned *d)
{
    unsigned si = 0, di = 0;
    __asm__ volatile("inl %%dx, %%eax" : "+a"(*a), "+b"(*b), "+c"(*c), "+d"(*d), "+S"(si), "+D"(di) : : "memory");
}

static void rpci(const char *text, unsigned length)
{
    unsigned a, b, c, d, channel, i;
    a = MAGIC; b = 0x49435052u | 0x80000000u; c = MESSAGE; d = PORT;
    backdoor(&a, &b, &c, &d);
    if (!((c >> 16) & 1)) return;
    channel = d >> 16;
    a = MAGIC; b = length; c = 1u << 16 | MESSAGE; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
    for (i = 0; i < length; i += 4) {
        unsigned v = 0, j;
        for (j = 0; j < 4 && i + j < length; j++) v |= (unsigned)(unsigned char)text[i + j] << 8 * j;
        a = MAGIC; b = v; c = 2u << 16 | MESSAGE; d = channel << 16 | PORT;
        backdoor(&a, &b, &c, &d);
    }
    a = MAGIC; b = 0; c = 3u << 16 | MESSAGE; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
    if ((c >> 16) & 2) {
        unsigned size = b;
        for (i = 0; i < size; i += 4) {
            a = MAGIC; b = 1; c = 4u << 16 | MESSAGE; d = channel << 16 | PORT;
            backdoor(&a, &b, &c, &d);
        }
        a = MAGIC; b = 1; c = 5u << 16 | MESSAGE; d = channel << 16 | PORT;
        backdoor(&a, &b, &c, &d);
    }
    a = MAGIC; b = 0; c = 6u << 16 | MESSAGE; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
}

static char g_options[200];

static void say(const char *format, ...)
{
    char text[400];
    int n = snprintf(text, sizeof text, "log d3d9step[%s]: ", g_options);
    va_list args;
    va_start(args, format);
    vsnprintf(text + n, sizeof text - n, format, args);
    va_end(args);
    rpci(text, (unsigned)strlen(text));
}

static DWORD g_start;
/* a call, logged before (it may not return) and after */
#define STEP(name, call) do { DWORD t0; say("> %s", name); t0 = GetTickCount(); hr = (call); \
    say("< %s -> 0x%08lX (%lu ms)", name, (unsigned long)hr, (unsigned long)(GetTickCount() - t0)); \
    if (FAILED(hr)) goto done; } while (0)

typedef struct { float x, y, z; DWORD color; float u, v; } Vertex;
static const Vertex g_vertices[] = {
    {-0.6f,  0.6f, 0.5f, 0xFFFFFFFF, 0.0f, 0.0f},
    { 0.6f,  0.6f, 0.5f, 0xFFFFA0A0, 1.0f, 0.0f},
    { 0.6f, -0.6f, 0.5f, 0xFFA0FFA0, 1.0f, 1.0f},
    {-0.6f,  0.6f, 0.5f, 0xFFFFFFFF, 0.0f, 0.0f},
    { 0.6f, -0.6f, 0.5f, 0xFFA0FFA0, 1.0f, 1.0f},
    {-0.6f, -0.6f, 0.5f, 0xFFA0A0FF, 0.0f, 1.0f},
};
static const WORD g_indices[] = { 0, 1, 2, 3, 4, 5 };
static const D3DVERTEXELEMENT9 g_declaration[] = {
    {0,  0, D3DDECLTYPE_FLOAT3,   D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0},
    {0, 12, D3DDECLTYPE_D3DCOLOR, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR,    0},
    {0, 16, D3DDECLTYPE_FLOAT2,   D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_TEXCOORD, 0},
    D3DDECL_END()
};
/* vs_2_0: m4x4 oPos, v0, c0; mov oD0, v1; mov oT0, v2 */
static const DWORD g_vs[] = {
    0xFFFE0200,
    0x0200001F, 0x80000000, 0x900F0000, 0x0200001F, 0x8000000A, 0x900F0001, 0x0200001F, 0x80000005, 0x900F0002,
    0x03000014, 0xC00F0000, 0x90E40000, 0xA0E40000,
    0x02000001, 0xD00F0000, 0x90E40001,
    0x02000001, 0xE00F0000, 0x90E40002,
    0x0000FFFF
};
/* ps_2_0 (d3d9_shader_test.c's): texld r0, t0, s0; mul r0, r0, v0; mad oC0, r0, c0, c1 */
static const DWORD g_ps[] = {
    0xFFFF0200,
    0x0200001F, 0x90000000, 0xA00F0800, 0x0200001F, 0x80000005, 0xB0030000, 0x0200001F, 0x8000000A, 0x900F0000,
    0x05000051, 0xA00F0001, 0x3DCCCCCD, 0x3DCCCCCD, 0x3DCCCCCD, 0x00000000,
    0x03000042, 0x800F0000, 0xB0E40000, 0xA0E40800,
    0x03000005, 0x800F0000, 0x80E40000, 0x90E40000,
    0x04000004, 0x800F0800, 0x80E40000, 0xA0E40000, 0xA0E40001,
    0x0000FFFF
};
static const float g_identity[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM w, LPARAM l)
{
    return DefWindowProcA(hwnd, message, w, l);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line, int show)
{
    int hw = strstr(command_line, "hw") != NULL, depth = strstr(command_line, "depth") != NULL;
    int vs = strstr(command_line, "vs") != NULL, indexed = strstr(command_line, "index") != NULL;
    int frames = 3, frame;
    const char *f = strstr(command_line, "frames=");
    IDirect3D9 *d3d = NULL;
    IDirect3DDevice9 *device = NULL;
    IDirect3DVertexBuffer9 *vb = NULL;
    IDirect3DIndexBuffer9 *ib = NULL;
    IDirect3DTexture9 *texture = NULL;
    IDirect3DVertexDeclaration9 *declaration = NULL;
    IDirect3DVertexShader9 *vertex_shader = NULL;
    IDirect3DPixelShader9 *pixel_shader = NULL;
    D3DPRESENT_PARAMETERS pp;
    D3DDISPLAYMODE mode;
    D3DLOCKED_RECT locked;
    WNDCLASSA wc;
    HWND hwnd;
    HRESULT hr = S_OK;
    void *bytes;
    int x, y;
    if (f) frames = atoi(f + 7);
    snprintf(g_options, sizeof g_options, "%s%s%s%s", hw ? "hw " : "sw ", depth ? "depth " : "", vs ? "vs " : "ff ",
        indexed ? "index" : "list");
    g_start = GetTickCount();
    say("start");
    ZeroMemory(&wc, sizeof wc);
    wc.lpfnWndProc = window_proc;
    wc.hInstance = instance;
    wc.lpszClassName = "D3D9Step";
    RegisterClassA(&wc);
    hwnd = CreateWindowA("D3D9Step", "d3d9step", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 40, 40, 320, 240, NULL, NULL, instance, NULL);
    d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) { say("Direct3DCreate9 failed"); return 1; }
    STEP("GetAdapterDisplayMode", IDirect3D9_GetAdapterDisplayMode(d3d, D3DADAPTER_DEFAULT, &mode));
    ZeroMemory(&pp, sizeof pp);
    pp.BackBufferWidth = 304; pp.BackBufferHeight = 202;
    pp.BackBufferFormat = mode.Format; pp.BackBufferCount = 1;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.hDeviceWindow = hwnd; pp.Windowed = TRUE;
    pp.EnableAutoDepthStencil = depth; pp.AutoDepthStencilFormat = D3DFMT_D24S8;
    STEP("CreateDevice", IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
        hw ? D3DCREATE_HARDWARE_VERTEXPROCESSING : D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &device));
    {
        D3DCAPS9 c;
        int which;
        for (which = 0; which < 2; which++) {
            ZeroMemory(&c, sizeof c);
            hr = which ? IDirect3DDevice9_GetDeviceCaps(device, &c) : IDirect3D9_GetDeviceCaps(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, &c);
            say("%s caps 0x%08lX: vs=%08lx ps=%08lx vsconst=%lu devcaps=%08lx devcaps2=%08lx caps2=%08lx", which ? "device" : "adapter",
                (unsigned long)hr, c.VertexShaderVersion, c.PixelShaderVersion, c.MaxVertexShaderConst, c.DevCaps, c.DevCaps2, c.Caps2);
            say("  vs20 caps=%lx dyn=%d temps=%d static=%d ps20 caps=%lx dyn=%d temps=%d static=%d slots=%d",
                c.VS20Caps.Caps, c.VS20Caps.DynamicFlowControlDepth, c.VS20Caps.NumTemps, c.VS20Caps.StaticFlowControlDepth,
                c.PS20Caps.Caps, c.PS20Caps.DynamicFlowControlDepth, c.PS20Caps.NumTemps, c.PS20Caps.StaticFlowControlDepth,
                c.PS20Caps.NumInstructionSlots);
            say("  vs30slots=%lu ps30slots=%lu vsexec=%lu psexec=%lu vtxsamplercaps=%lx maxstreams=%lu decltypes=%lx rts=%lu",
                c.MaxVertexShader30InstructionSlots, c.MaxPixelShader30InstructionSlots, c.MaxVShaderInstructionsExecuted,
                c.MaxPShaderInstructionsExecuted, c.VertexTextureFilterCaps, c.MaxStreams, c.DeclTypes, c.NumSimultaneousRTs);
            say("  maxtex=%lux%lu aspect=%lu aniso=%lu primcount=%lu index=%lu vertexproc=%lx pshadermax=%f",
                c.MaxTextureWidth, c.MaxTextureHeight, c.MaxTextureAspectRatio, c.MaxAnisotropy, c.MaxPrimitiveCount,
                c.MaxVertexIndex, c.VertexProcessingCaps, (double)c.PixelShader1xMaxValue);
        }
    }
    STEP("CreateVertexBuffer", IDirect3DDevice9_CreateVertexBuffer(device, sizeof g_vertices, D3DUSAGE_WRITEONLY, 0,
        D3DPOOL_MANAGED, &vb, NULL));
    STEP("VertexBuffer::Lock", IDirect3DVertexBuffer9_Lock(vb, 0, 0, &bytes, 0));
    memcpy(bytes, g_vertices, sizeof g_vertices);
    STEP("VertexBuffer::Unlock", IDirect3DVertexBuffer9_Unlock(vb));
    if (indexed) {
        STEP("CreateIndexBuffer", IDirect3DDevice9_CreateIndexBuffer(device, sizeof g_indices, D3DUSAGE_WRITEONLY,
            D3DFMT_INDEX16, D3DPOOL_MANAGED, &ib, NULL));
        STEP("IndexBuffer::Lock", IDirect3DIndexBuffer9_Lock(ib, 0, 0, &bytes, 0));
        memcpy(bytes, g_indices, sizeof g_indices);
        STEP("IndexBuffer::Unlock", IDirect3DIndexBuffer9_Unlock(ib));
    }
    STEP("CreateVertexDeclaration", IDirect3DDevice9_CreateVertexDeclaration(device, g_declaration, &declaration));
    STEP("CreateTexture", IDirect3DDevice9_CreateTexture(device, 16, 16, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED,
        &texture, NULL));
    STEP("Texture::LockRect", IDirect3DTexture9_LockRect(texture, 0, &locked, NULL, 0));
    for (y = 0; y < 16; y++)
        for (x = 0; x < 16; x++) ((DWORD *)((BYTE *)locked.pBits + y * locked.Pitch))[x] = D3DCOLOR_ARGB(255, x * 16, y * 16, 128);
    STEP("Texture::UnlockRect", IDirect3DTexture9_UnlockRect(texture, 0));
    if (strstr(command_line, "psvariants")) {
        /* which pixel shaders the driver takes */
        static const DWORD ff[] = { 0xffff0200, 0x2fffe, 0x54584554, 0x464624, 0x200001f, 0x80000000, 0x900f0000,
            0x200001f, 0x80000000, 0xb00f0000, 0x200001f, 0x90000000, 0xa00f0800, 0x3000042, 0x802f0001, 0xb0e40000,
            0xa0e40800, 0x3000005, 0x80370005, 0x80e40001, 0x90e40000, 0x2000001, 0x80380005, 0x80e40001, 0x2000001,
            0x802f0001, 0x80e40005, 0x2000001, 0x802f0800, 0x80e40001, 0xffff };
        static const DWORD ff_nocomment[] = { 0xffff0200, 0x200001f, 0x80000000, 0x900f0000,
            0x200001f, 0x80000000, 0xb00f0000, 0x200001f, 0x90000000, 0xa00f0800, 0x3000042, 0x802f0001, 0xb0e40000,
            0xa0e40800, 0x3000005, 0x80370005, 0x80e40001, 0x90e40000, 0x2000001, 0x80380005, 0x80e40001, 0x2000001,
            0x802f0001, 0x80e40005, 0x2000001, 0x802f0800, 0x80e40001, 0xffff };
        static const DWORD ps20_const[] = { 0xffff0200, 0x02000001, 0x800f0800, 0xa0e40000, 0xffff };
        static const DWORD ps30_const[] = { 0xffff0300, 0x02000001, 0x800f0800, 0xa0e40000, 0xffff };
        static const DWORD ps11_const[] = { 0xffff0101, 0x00000001, 0x800f0000, 0xa0e40000, 0xffff };
        static const DWORD ps20_def[] = { 0xffff0200, 0x05000051, 0xa00f0001, 0x3f800000, 0, 0, 0x3f800000,
            0x02000001, 0x800f0800, 0xa0e40001, 0xffff };
        static const DWORD ps20_v0[] = { 0xffff0200, 0x0200001f, 0x80000000, 0x900f0000, 0x02000001, 0x800f0800, 0x90e40000, 0xffff };
        static const DWORD ps20_tex[] = { 0xffff0200, 0x0200001f, 0x90000000, 0xa00f0800, 0x0200001f, 0x80000000, 0xb00f0000,
            0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x02000001, 0x800f0800, 0x80e40000, 0xffff };
        static const struct { const char *name; const DWORD *code; } variants[] = {
            { "driver ff (comment)", ff }, { "driver ff", ff_nocomment }, { "ps_1_1 mov r0 c0", ps11_const },
            { "ps_2_0 mov oC0 c0", ps20_const }, { "ps_3_0 mov oC0 c0", ps30_const }, { "ps_2_0 def", ps20_def },
            { "ps_2_0 v0", ps20_v0 }, { "ps_2_0 texld", ps20_tex }, { "sample", g_ps },
        };
        int k;
        for (k = 0; k < (int)(sizeof variants / sizeof variants[0]); k++) {
            IDirect3DPixelShader9 *ps = NULL;
            HRESULT r = IDirect3DDevice9_CreatePixelShader(device, variants[k].code, &ps);
            say("CreatePixelShader(%s) -> 0x%08lX", variants[k].name, (unsigned long)r);
            if (ps) IDirect3DPixelShader9_Release(ps);
        }
    }
    if (vs) {
        STEP("CreateVertexShader", IDirect3DDevice9_CreateVertexShader(device, g_vs, &vertex_shader));
        STEP("CreatePixelShader", IDirect3DDevice9_CreatePixelShader(device, g_ps, &pixel_shader));
        STEP("SetVertexShaderConstantF", IDirect3DDevice9_SetVertexShaderConstantF(device, 0, g_identity, 4));
        STEP("SetPixelShaderConstantF", IDirect3DDevice9_SetPixelShaderConstantF(device, 0, g_identity, 1));
        STEP("SetVertexShader", IDirect3DDevice9_SetVertexShader(device, vertex_shader));
        STEP("SetPixelShader", IDirect3DDevice9_SetPixelShader(device, pixel_shader));
    } else {
        STEP("SetRenderState LIGHTING", IDirect3DDevice9_SetRenderState(device, D3DRS_LIGHTING, FALSE));
    }
    STEP("SetVertexDeclaration", IDirect3DDevice9_SetVertexDeclaration(device, declaration));
    STEP("SetStreamSource", IDirect3DDevice9_SetStreamSource(device, 0, vb, 0, sizeof(Vertex)));
    if (indexed) STEP("SetIndices", IDirect3DDevice9_SetIndices(device, ib));
    STEP("SetTexture", IDirect3DDevice9_SetTexture(device, 0, (IDirect3DBaseTexture9 *)texture));
    STEP("SetRenderState CULLMODE", IDirect3DDevice9_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE));
    for (frame = 0; frame < frames; frame++) {
        say("frame %d", frame);
        STEP("Clear", IDirect3DDevice9_Clear(device, 0, NULL, D3DCLEAR_TARGET | (depth ? D3DCLEAR_ZBUFFER : 0),
            D3DCOLOR_XRGB(16, 24, 32 + 40 * frame), 1.0f, 0));
        STEP("BeginScene", IDirect3DDevice9_BeginScene(device));
        if (indexed) STEP("DrawIndexedPrimitive", IDirect3DDevice9_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, 0, 0, 6, 0, 2));
        else STEP("DrawPrimitive", IDirect3DDevice9_DrawPrimitive(device, D3DPT_TRIANGLELIST, 0, 2));
        STEP("EndScene", IDirect3DDevice9_EndScene(device));
        STEP("Present", IDirect3DDevice9_Present(device, NULL, NULL, NULL, NULL));
    }
done:
    say("end 0x%08lX after %lu ms", (unsigned long)hr, (unsigned long)(GetTickCount() - g_start));
    if (pixel_shader) IDirect3DPixelShader9_Release(pixel_shader);
    if (vertex_shader) IDirect3DVertexShader9_Release(vertex_shader);
    if (declaration) IDirect3DVertexDeclaration9_Release(declaration);
    if (texture) IDirect3DTexture9_Release(texture);
    if (ib) IDirect3DIndexBuffer9_Release(ib);
    if (vb) IDirect3DVertexBuffer9_Release(vb);
    if (device) IDirect3DDevice9_Release(device);
    if (d3d) IDirect3D9_Release(d3d);
    DestroyWindow(hwnd);
    return 0;
}
