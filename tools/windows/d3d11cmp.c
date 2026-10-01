// d3d11cmp.exe: Direct3D 11 at feature level 10_0, drawn by the hardware
// driver and by WARP, compared. Each case renders a 64x64 RGBA8 picture
// offscreen with shaders compiled here by d3dcompiler_47 (from HLSL), reads it
// back, and reports through the VMware backdoor (RPCI "log", printed by
// tests/x64/windows_boot.mjs) how far the hardware picture is from WARP's.
// With VMware's driver on v86's SVGA II device, "hardware" is GX on WebGPU.
//
//   d3d11cmp.exe [case ...]     (default: every case)
//
//   x86_64-w64-mingw32-gcc -O2 -mwindows -o D3D11CMP.EXE d3d11cmp.c -ld3d11 -ldxguid
//
// v86 lets user mode use the backdoor port, as VMware does.

#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <stdio.h>
#include <string.h>

#define MAGIC 0x564D5868u
#define PORT 0x5658u
#define MESSAGE 30u
#define SIZE 64

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

static void say(const char *format, ...)
{
    char text[600];
    int n = snprintf(text, sizeof text, "log d3d11cmp: ");
    va_list args;
    va_start(args, format);
    vsnprintf(text + n, sizeof text - n, format, args);
    va_end(args);
    rpci(text, (unsigned)strlen(text));
}

typedef HRESULT (WINAPI *Compile)(const void *, SIZE_T, const char *, const D3D_SHADER_MACRO *, ID3DInclude *,
    const char *, const char *, UINT, UINT, ID3DBlob **, ID3DBlob **);
static Compile g_compile;

/* A device and what every case draws into */
typedef struct {
    const char *name;
    ID3D11Device *device;
    ID3D11DeviceContext *context;
    ID3D11Texture2D *target, *staging;
    ID3D11RenderTargetView *rtv;
    unsigned char pixels[SIZE * SIZE * 4];
} Device;

static ID3DBlob *compile(const char *source, const char *entry, const char *profile)
{
    ID3DBlob *code = NULL, *errors = NULL;
    HRESULT hr = g_compile(source, strlen(source), "case", NULL, NULL, entry, profile, 0, 0, &code, &errors);
    if (FAILED(hr)) {
        say("compile %s %s failed 0x%08lX: %.300s", entry, profile, (unsigned long)hr,
            errors ? (const char *)ID3D10Blob_GetBufferPointer(errors) : "");
        if (errors) ID3D10Blob_Release(errors);
        return NULL;
    }
    if (errors) ID3D10Blob_Release(errors);
    return code;
}

static ID3D11VertexShader *vs(Device *d, const char *source, ID3DBlob **keep)
{
    ID3D11VertexShader *shader = NULL;
    ID3DBlob *code = compile(source, "vs", "vs_4_0");
    if (!code) return NULL;
    ID3D11Device_CreateVertexShader(d->device, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code), NULL, &shader);
    if (keep) *keep = code; else ID3D10Blob_Release(code);
    return shader;
}

static ID3D11PixelShader *ps(Device *d, const char *source)
{
    ID3D11PixelShader *shader = NULL;
    ID3DBlob *code = compile(source, "ps", "ps_4_0");
    if (!code) return NULL;
    ID3D11Device_CreatePixelShader(d->device, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code), NULL, &shader);
    ID3D10Blob_Release(code);
    return shader;
}

static ID3D11Buffer *buffer(Device *d, UINT bind, const void *data, UINT size)
{
    D3D11_BUFFER_DESC desc;
    D3D11_SUBRESOURCE_DATA init;
    ID3D11Buffer *b = NULL;
    ZeroMemory(&desc, sizeof desc);
    desc.ByteWidth = (size + 15) & ~15u;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = bind;
    init.pSysMem = data; init.SysMemPitch = 0; init.SysMemSlicePitch = 0;
    ID3D11Device_CreateBuffer(d->device, &desc, data ? &init : NULL, &b);
    return b;
}

static void begin(Device *d, float r, float g, float b)
{
    float clear[4] = { r, g, b, 1 };
    D3D11_VIEWPORT viewport = { 0, 0, SIZE, SIZE, 0, 1 };
    ID3D11DeviceContext_ClearState(d->context);
    ID3D11DeviceContext_ClearRenderTargetView(d->context, d->rtv, clear);
    ID3D11DeviceContext_OMSetRenderTargets(d->context, 1, &d->rtv, NULL);
    ID3D11DeviceContext_RSSetViewports(d->context, 1, &viewport);
}

static void read_back(Device *d)
{
    D3D11_MAPPED_SUBRESOURCE mapped;
    int y;
    ID3D11DeviceContext_CopyResource(d->context, (ID3D11Resource *)d->staging, (ID3D11Resource *)d->target);
    if (FAILED(ID3D11DeviceContext_Map(d->context, (ID3D11Resource *)d->staging, 0, D3D11_MAP_READ, 0, &mapped))) {
        memset(d->pixels, 0, sizeof d->pixels);
        return;
    }
    for (y = 0; y < SIZE; y++) memcpy(d->pixels + y * SIZE * 4, (unsigned char *)mapped.pData + y * mapped.RowPitch, SIZE * 4);
    ID3D11DeviceContext_Unmap(d->context, (ID3D11Resource *)d->staging, 0);
}

/* ---- the cases: each draws into d's target ---- */

/* full-screen triangles from SV_VertexID, uv in TEXCOORD0 */
static const char QUAD_VS[] =
    "struct O { float4 p : SV_Position; float2 uv : TEXCOORD0; };"
    "O vs(uint i : SV_VertexID) { O o; float2 c = float2((i << 1) & 2, i & 2);"
    " o.uv = c * 0.5; o.p = float4(c.x - 1, 1 - c.y, 0, 1); o.uv = float2(c.x, c.y) * 0.5; return o; }";

static void case_triangle(Device *d)
{
    static const char source[] =
        "struct I { float2 p : POSITION; float4 c : COLOR; }; struct O { float4 p : SV_Position; float4 c : COLOR; };"
        "O vs(I i) { O o; o.p = float4(i.p, 0, 1); o.c = i.c; return o; }"
        "float4 ps(O i) : SV_Target { return i.c; }";
    static const float vertices[] = { -0.8f, -0.8f, 1, 0, 0, 1,  0, 0.8f, 0, 1, 0, 1,  0.8f, -0.8f, 0, 0, 1, 1 };
    static const D3D11_INPUT_ELEMENT_DESC layout[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    ID3DBlob *code = NULL;
    ID3D11VertexShader *v = vs(d, source, &code);
    ID3D11PixelShader *p = ps(d, source);
    ID3D11InputLayout *il = NULL;
    ID3D11Buffer *vb = buffer(d, D3D11_BIND_VERTEX_BUFFER, vertices, sizeof vertices);
    UINT stride = 24, offset = 0;
    if (!v || !p) return;
    ID3D11Device_CreateInputLayout(d->device, layout, 2, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code), &il);
    begin(d, 0.1f, 0.1f, 0.3f);
    ID3D11DeviceContext_IASetInputLayout(d->context, il);
    ID3D11DeviceContext_IASetVertexBuffers(d->context, 0, 1, &vb, &stride, &offset);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_Draw(d->context, 3, 0);
    ID3D11InputLayout_Release(il); ID3D11Buffer_Release(vb); ID3D10Blob_Release(code);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_texture(Device *d)
{
    /* a 16x16 gradient with generated mips: the left half samples level 0
       (linear), the right half level 2 */
    static const char source[] =
        "Texture2D t : register(t0); SamplerState s : register(s0);"
        "struct O { float4 p : SV_Position; float2 uv : TEXCOORD0; };"
        "float4 ps(O i) : SV_Target { return i.uv.x < 0.5 ? t.Sample(s, i.uv * 2) : t.SampleLevel(s, i.uv * 2, 2); }";
    D3D11_TEXTURE2D_DESC desc;
    D3D11_SAMPLER_DESC sampler_desc;
    ID3D11Texture2D *texture = NULL;
    ID3D11ShaderResourceView *srv = NULL;
    ID3D11SamplerState *sampler = NULL;
    unsigned texels[16 * 16];
    int x, y;
    ID3D11VertexShader *v = vs(d, QUAD_VS, NULL);
    ID3D11PixelShader *p = ps(d, source);
    if (!v || !p) return;
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) texels[y * 16 + x] = 0xFF000000u | (unsigned)(x * 16) | (unsigned)(y * 16) << 8 | ((x ^ y) & 1 ? 0xFF0000u : 0);
    ZeroMemory(&desc, sizeof desc);
    desc.Width = desc.Height = 16; desc.MipLevels = 0; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET; desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;
    ID3D11Device_CreateTexture2D(d->device, &desc, NULL, &texture);
    ID3D11DeviceContext_UpdateSubresource(d->context, (ID3D11Resource *)texture, 0, NULL, texels, 64, 0);
    ID3D11Device_CreateShaderResourceView(d->device, (ID3D11Resource *)texture, NULL, &srv);
    ID3D11DeviceContext_GenerateMips(d->context, srv);
    ZeroMemory(&sampler_desc, sizeof sampler_desc);
    sampler_desc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler_desc.AddressU = sampler_desc.AddressV = sampler_desc.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
    sampler_desc.MaxLOD = D3D11_FLOAT32_MAX;
    ID3D11Device_CreateSamplerState(d->device, &sampler_desc, &sampler);
    begin(d, 0, 0, 0);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_PSSetShaderResources(d->context, 0, 1, &srv);
    ID3D11DeviceContext_PSSetSamplers(d->context, 0, 1, &sampler);
    ID3D11DeviceContext_Draw(d->context, 3, 0);
    ID3D11SamplerState_Release(sampler); ID3D11ShaderResourceView_Release(srv); ID3D11Texture2D_Release(texture);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_depth_blend(Device *d)
{
    /* three overlapping quads at different depths, drawn back, front, middle
       with LESS; then a half-transparent quad blended over everything */
    static const char source[] =
        "cbuffer C : register(b0) { float4 rect; float4 color; float depth; };"
        "float4 vs(uint i : SV_VertexID) : SV_Position { float2 c = float2(i & 1, i >> 1);"
        " return float4(lerp(rect.xy, rect.zw, c), depth, 1); }"
        "float4 ps(float4 p : SV_Position) : SV_Target { return color; }";
    static const float quads[4][12] = {
        { -0.9f, -0.9f, 0.3f, 0.3f,  1, 0, 0, 1,  0.8f, 0, 0, 0 },
        { -0.3f, -0.3f, 0.9f, 0.9f,  0, 1, 0, 1,  0.2f, 0, 0, 0 },
        { -0.6f, -0.6f, 0.6f, 0.6f,  0, 0, 1, 1,  0.5f, 0, 0, 0 },
        { -1.0f, -0.1f, 1.0f, 0.1f,  1, 1, 1, 0.5f, 0.0f, 0, 0, 0 },
    };
    D3D11_TEXTURE2D_DESC desc;
    D3D11_DEPTH_STENCIL_DESC ds_desc;
    D3D11_BLEND_DESC blend_desc;
    ID3D11Texture2D *depth = NULL;
    ID3D11DepthStencilView *dsv = NULL;
    ID3D11DepthStencilState *ds = NULL, *no_depth = NULL;
    ID3D11BlendState *blend = NULL;
    ID3D11Buffer *cb = buffer(d, D3D11_BIND_CONSTANT_BUFFER, NULL, sizeof quads[0]);
    ID3D11VertexShader *v = vs(d, source, NULL);
    ID3D11PixelShader *p = ps(d, source);
    int i;
    if (!v || !p) return;
    ZeroMemory(&desc, sizeof desc);
    desc.Width = desc.Height = SIZE; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_D24_UNORM_S8_UINT; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_DEPTH_STENCIL;
    ID3D11Device_CreateTexture2D(d->device, &desc, NULL, &depth);
    ID3D11Device_CreateDepthStencilView(d->device, (ID3D11Resource *)depth, NULL, &dsv);
    ZeroMemory(&ds_desc, sizeof ds_desc);
    ds_desc.DepthEnable = TRUE; ds_desc.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL; ds_desc.DepthFunc = D3D11_COMPARISON_LESS;
    ID3D11Device_CreateDepthStencilState(d->device, &ds_desc, &ds);
    ds_desc.DepthEnable = FALSE;
    ID3D11Device_CreateDepthStencilState(d->device, &ds_desc, &no_depth);
    ZeroMemory(&blend_desc, sizeof blend_desc);
    blend_desc.RenderTarget[0].BlendEnable = TRUE;
    blend_desc.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA; blend_desc.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    blend_desc.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    blend_desc.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE; blend_desc.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO;
    blend_desc.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    blend_desc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    ID3D11Device_CreateBlendState(d->device, &blend_desc, &blend);
    begin(d, 0.2f, 0.2f, 0.2f);
    ID3D11DeviceContext_ClearDepthStencilView(d->context, dsv, D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);
    ID3D11DeviceContext_OMSetRenderTargets(d->context, 1, &d->rtv, dsv);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_VSSetConstantBuffers(d->context, 0, 1, &cb);
    ID3D11DeviceContext_PSSetConstantBuffers(d->context, 0, 1, &cb);
    for (i = 0; i < 4; i++) {
        if (i == 3) {
            ID3D11DeviceContext_OMSetDepthStencilState(d->context, no_depth, 0);
            ID3D11DeviceContext_OMSetBlendState(d->context, blend, NULL, 0xFFFFFFFF);
        } else {
            ID3D11DeviceContext_OMSetDepthStencilState(d->context, ds, 0);
        }
        ID3D11DeviceContext_UpdateSubresource(d->context, (ID3D11Resource *)cb, 0, NULL, quads[i], 0, 0);
        ID3D11DeviceContext_Draw(d->context, 4, 0);
    }
    ID3D11BlendState_Release(blend); ID3D11DepthStencilState_Release(ds); ID3D11DepthStencilState_Release(no_depth);
    ID3D11DepthStencilView_Release(dsv); ID3D11Texture2D_Release(depth); ID3D11Buffer_Release(cb);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_instancing(Device *d)
{
    /* 16 small quads, placed and coloured from SV_InstanceID; integer ops */
    static const char source[] =
        "struct O { float4 p : SV_Position; nointerpolation uint id : ID; };"
        "O vs(uint v : SV_VertexID, uint i : SV_InstanceID) { O o; float2 c = float2(v & 1, v >> 1);"
        " float2 at = float2(i & 3, i >> 2) * 0.5 - 1 + 0.05; o.p = float4(at + c * 0.4, 0, 1); o.id = i; return o; }"
        "float4 ps(O i) : SV_Target { uint h = (i.id * 2654435761u) >> 8; uint2 q = uint2(i.p.xy) & 3;"
        " return float4(((h >> 0) & 255) / 255.0, ((h >> 8) & 255) / 255.0, (q.x ^ q.y) / 3.0, 1); }";
    ID3D11VertexShader *v = vs(d, source, NULL);
    ID3D11PixelShader *p = ps(d, source);
    if (!v || !p) return;
    begin(d, 0, 0, 0);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_DrawInstanced(d->context, 4, 16, 0, 0);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_gs(Device *d)
{
    /* points expanded into quads by a geometry shader */
    static const char source[] =
        "struct V { float4 p : SV_Position; float4 c : COLOR; };"
        "V vs(uint i : SV_VertexID) { V o; o.p = float4((i & 3) * 0.5 - 0.75, (i >> 2) * 0.5 - 0.75, 0, 1);"
        " o.c = float4((i & 3) / 3.0, (i >> 2) / 3.0, 1, 1); return o; }"
        "[maxvertexcount(4)] void gs(point V i[1], inout TriangleStream<V> s) { V o = i[0];"
        " o.p.xy = i[0].p.xy + float2(-0.15, -0.15); s.Append(o); o.p.xy = i[0].p.xy + float2(-0.15, 0.15); s.Append(o);"
        " o.p.xy = i[0].p.xy + float2(0.15, -0.15); s.Append(o); o.p.xy = i[0].p.xy + float2(0.15, 0.15); s.Append(o); }"
        "float4 ps(V i) : SV_Target { return i.c; }";
    ID3D11GeometryShader *g = NULL;
    ID3DBlob *code = compile(source, "gs", "gs_4_0");
    ID3D11VertexShader *v = vs(d, source, NULL);
    ID3D11PixelShader *p = ps(d, source);
    if (!v || !p || !code) return;
    ID3D11Device_CreateGeometryShader(d->device, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code), NULL, &g);
    begin(d, 0, 0, 0);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_POINTLIST);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_GSSetShader(d->context, g, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_Draw(d->context, 16, 0);
    ID3D11GeometryShader_Release(g); ID3D10Blob_Release(code);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_msaa(Device *d)
{
    /* a triangle into a 4x multisampled target, resolved */
    static const char source[] =
        "float4 vs(uint i : SV_VertexID) : SV_Position { return float4(i == 1 ? 0.9 : -0.9, i == 2 ? 0.9 : -0.7, 0, 1); }"
        "float4 ps(float4 p : SV_Position) : SV_Target { return float4(1, 0.8, 0.2, 1); }";
    D3D11_TEXTURE2D_DESC desc;
    ID3D11Texture2D *ms = NULL;
    ID3D11RenderTargetView *rtv = NULL;
    float clear[4] = { 0, 0, 0.4f, 1 };
    D3D11_VIEWPORT viewport = { 0, 0, SIZE, SIZE, 0, 1 };
    ID3D11VertexShader *v = vs(d, source, NULL);
    ID3D11PixelShader *p = ps(d, source);
    if (!v || !p) return;
    ZeroMemory(&desc, sizeof desc);
    desc.Width = desc.Height = SIZE; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 4; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(ID3D11Device_CreateTexture2D(d->device, &desc, NULL, &ms))) { say("%s: no 4x MSAA target", d->name); return; }
    ID3D11Device_CreateRenderTargetView(d->device, (ID3D11Resource *)ms, NULL, &rtv);
    ID3D11DeviceContext_ClearState(d->context);
    ID3D11DeviceContext_ClearRenderTargetView(d->context, rtv, clear);
    ID3D11DeviceContext_OMSetRenderTargets(d->context, 1, &rtv, NULL);
    ID3D11DeviceContext_RSSetViewports(d->context, 1, &viewport);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_Draw(d->context, 3, 0);
    ID3D11DeviceContext_ResolveSubresource(d->context, (ID3D11Resource *)d->target, 0, (ID3D11Resource *)ms, 0, DXGI_FORMAT_R8G8B8A8_UNORM);
    ID3D11RenderTargetView_Release(rtv); ID3D11Texture2D_Release(ms);
    ID3D11VertexShader_Release(v); ID3D11PixelShader_Release(p);
}

static void case_stream_output(Device *d)
{
    /* the vertex shader's triangle captured by stream output, then drawn
       again from the captured buffer with DrawAuto, moved */
    static const char source[] =
        "struct V { float4 p : SV_Position; float4 c : COLOR; };"
        "V vs(uint i : SV_VertexID) { V o; o.p = float4(i == 1 ? 0.0 : -0.8, i == 2 ? 0.0 : -0.8, 0, 1);"
        " o.c = float4(i == 0, i == 1, i == 2, 1); return o; }"
        "struct I { float4 p : POSITION; float4 c : COLOR; };"
        "V vs2(I i) { V o; o.p = i.p + float4(0.8, 0.8, 0, 0); o.c = i.c; return o; }"
        "float4 ps(V i) : SV_Target { return i.c; }";
    static const D3D11_SO_DECLARATION_ENTRY so[] = {
        { 0, "SV_Position", 0, 0, 4, 0 }, { 0, "COLOR", 0, 0, 4, 0 },
    };
    static const D3D11_INPUT_ELEMENT_DESC layout[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    UINT stride = 32, offset = 0;
    ID3D11GeometryShader *g = NULL;
    ID3D11VertexShader *v2 = NULL;
    ID3D11InputLayout *il = NULL;
    ID3D11Buffer *captured = buffer(d, D3D11_BIND_STREAM_OUTPUT | D3D11_BIND_VERTEX_BUFFER, NULL, 32 * 3);
    ID3DBlob *code = compile(source, "vs", "vs_4_0"), *code2 = compile(source, "vs2", "vs_4_0");
    ID3D11VertexShader *v = NULL;
    ID3D11PixelShader *p = ps(d, source);
    if (!code || !code2 || !p) return;
    ID3D11Device_CreateVertexShader(d->device, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code), NULL, &v);
    ID3D11Device_CreateVertexShader(d->device, ID3D10Blob_GetBufferPointer(code2), ID3D10Blob_GetBufferSize(code2), NULL, &v2);
    ID3D11Device_CreateGeometryShaderWithStreamOutput(d->device, ID3D10Blob_GetBufferPointer(code), ID3D10Blob_GetBufferSize(code),
        so, 2, &stride, 1, D3D11_SO_NO_RASTERIZED_STREAM, NULL, &g);
    ID3D11Device_CreateInputLayout(d->device, layout, 2, ID3D10Blob_GetBufferPointer(code2), ID3D10Blob_GetBufferSize(code2), &il);
    begin(d, 0, 0, 0);
    ID3D11DeviceContext_IASetPrimitiveTopology(d->context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(d->context, v, NULL, 0);
    ID3D11DeviceContext_GSSetShader(d->context, g, NULL, 0);
    ID3D11DeviceContext_PSSetShader(d->context, p, NULL, 0);
    ID3D11DeviceContext_SOSetTargets(d->context, 1, &captured, &offset);
    ID3D11DeviceContext_Draw(d->context, 3, 0);
    ID3D11DeviceContext_SOSetTargets(d->context, 0, NULL, NULL);
    ID3D11DeviceContext_GSSetShader(d->context, NULL, NULL, 0);
    ID3D11DeviceContext_VSSetShader(d->context, v2, NULL, 0);
    ID3D11DeviceContext_IASetInputLayout(d->context, il);
    ID3D11DeviceContext_IASetVertexBuffers(d->context, 0, 1, &captured, &stride, &offset);
    ID3D11DeviceContext_DrawAuto(d->context);
    if (il) ID3D11InputLayout_Release(il);
    if (g) ID3D11GeometryShader_Release(g);
    ID3D11Buffer_Release(captured); ID3D10Blob_Release(code); ID3D10Blob_Release(code2);
    ID3D11VertexShader_Release(v); ID3D11VertexShader_Release(v2); ID3D11PixelShader_Release(p);
}

static const struct { const char *name; void (*run)(Device *); } CASES[] = {
    { "triangle", case_triangle }, { "texture", case_texture }, { "depth_blend", case_depth_blend },
    { "instancing", case_instancing }, { "gs", case_gs }, { "msaa", case_msaa }, { "stream_output", case_stream_output },
};

static int open_device(Device *d, D3D_DRIVER_TYPE type, const char *name)
{
    D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_10_0, got = 0;
    D3D11_TEXTURE2D_DESC desc;
    HRESULT hr = D3D11CreateDevice(NULL, type, NULL, 0, &level, 1, D3D11_SDK_VERSION, &d->device, &got, &d->context);
    d->name = name;
    if (FAILED(hr)) { say("%s: D3D11CreateDevice 0x%08lX", name, (unsigned long)hr); return 0; }
    ZeroMemory(&desc, sizeof desc);
    desc.Width = desc.Height = SIZE; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    ID3D11Device_CreateTexture2D(d->device, &desc, NULL, &d->target);
    ID3D11Device_CreateRenderTargetView(d->device, (ID3D11Resource *)d->target, NULL, &d->rtv);
    desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ID3D11Device_CreateTexture2D(d->device, &desc, NULL, &d->staging);
    say("%s: feature level 0x%x", name, got);
    return 1;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line, int show)
{
    Device hw, warp;
    HMODULE compiler = LoadLibraryA("d3dcompiler_47.dll");
    unsigned k;
    int passed = 0, failed = 0;
    ZeroMemory(&hw, sizeof hw); ZeroMemory(&warp, sizeof warp);
    g_compile = compiler ? (Compile)GetProcAddress(compiler, "D3DCompile") : NULL;
    if (!g_compile) { say("no d3dcompiler_47.dll"); return 1; }
    if (!open_device(&hw, D3D_DRIVER_TYPE_HARDWARE, "hardware") || !open_device(&warp, D3D_DRIVER_TYPE_WARP, "warp")) {
        say("end: no devices");
        return 1;
    }
    for (k = 0; k < sizeof CASES / sizeof CASES[0]; k++) {
        int i, worst = 0, off = 0, sample;
        if (*command_line && !strstr(command_line, CASES[k].name)) continue;
        CASES[k].run(&hw); read_back(&hw);
        CASES[k].run(&warp); read_back(&warp);
        for (i = 0; i < SIZE * SIZE * 4; i++) {
            int diff = abs((int)hw.pixels[i] - (int)warp.pixels[i]);
            if (diff > worst) worst = diff;
            if (diff > 16 && (i & 3) != 3) off++;
        }
        /* a few pixels of each, for the log */
        sample = (SIZE / 2 * SIZE + SIZE / 2) * 4;
        say("case %s: %s, worst %d, %d channels off by more than 16; centre hw %02x%02x%02x%02x warp %02x%02x%02x%02x",
            CASES[k].name, off ? "DIFFERS" : "same", worst, off,
            hw.pixels[sample], hw.pixels[sample + 1], hw.pixels[sample + 2], hw.pixels[sample + 3],
            warp.pixels[sample], warp.pixels[sample + 1], warp.pixels[sample + 2], warp.pixels[sample + 3]);
        if (off) failed++; else passed++;
    }
    say("end: %d same, %d differ", passed, failed);
    return 0;
}
