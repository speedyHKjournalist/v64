// d3dprobe.exe: what Direct3D makes of the display adapter, sent to the host
// as VMware RPCI log lines (like rpcilog.c): the DXGI adapters, a D3D11
// hardware device (the feature level it gets, or the error), and a D3D9 HAL
// device with its caps. Run by the log agent when the screen shows nothing.
//
//   x86_64-w64-mingw32-gcc -O2 -nostdlib -e entry -o D3DPROBE64.EXE d3dprobe.c -ld3d11 -ldxgi -ld3d9 -luser32 -lkernel32
//   i686-w64-mingw32-gcc -O2 -nostdlib -e _entry@0 -o D3DPROBE32.EXE d3dprobe.c -ld3d11 -ldxgi -ld3d9 -luser32 -lkernel32

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <d3d9.h>

#define MAGIC 0x564D5868u
#define PORT 0x5658u

static void backdoor(unsigned *a, unsigned *b, unsigned *c, unsigned *d)
{
    unsigned si = 0, di = 0;
    __asm__ volatile("inl %%dx, %%eax" : "+a"(*a), "+b"(*b), "+c"(*c), "+d"(*d), "+S"(si), "+D"(di) : : "memory");
}

static void rpci_log(const char *text)
{
    unsigned a, b, c, d, channel, i, length = 4 + lstrlenA(text);
    char message[600];
    lstrcpyA(message, "log ");
    lstrcpynA(message + 4, text, sizeof message - 4);
    if (length > sizeof message - 1) length = sizeof message - 1;
    a = MAGIC; b = 0x49435052u | 0x80000000u; c = 30; d = PORT;
    backdoor(&a, &b, &c, &d);
    if (!((c >> 16) & 1)) return;
    channel = d >> 16;
    a = MAGIC; b = length; c = 1u << 16 | 30; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
    for (i = 0; i < length; i += 4) {
        unsigned v = 0, j;
        for (j = 0; j < 4 && i + j < length; j++) v |= (unsigned)(unsigned char)message[i + j] << 8 * j;
        a = MAGIC; b = v; c = 2u << 16 | 30; d = channel << 16 | PORT;
        backdoor(&a, &b, &c, &d);
    }
    a = MAGIC; b = 0; c = 3u << 16 | 30; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
    if ((c >> 16) & 2) {
        unsigned size = b;
        for (i = 0; i < size; i += 4) { a = MAGIC; b = 1; c = 4u << 16 | 30; d = channel << 16 | PORT; backdoor(&a, &b, &c, &d); }
        a = MAGIC; b = 1; c = 5u << 16 | 30; d = channel << 16 | PORT; backdoor(&a, &b, &c, &d);
    }
    a = MAGIC; b = 0; c = 6u << 16 | 30; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
}

static char line[512];
#define LOG(...) do { wsprintfA(line, __VA_ARGS__); rpci_log(line); } while (0)

#ifdef _WIN64
#define BITS "d3dprobe64"
#else
#define BITS "d3dprobe32"
#endif

static void probe_dxgi(void)
{
    IDXGIFactory1 *factory = NULL;
    IDXGIAdapter1 *adapter;
    UINT i;
    HRESULT hr = CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
    LOG(BITS ": CreateDXGIFactory1 -> 0x%08lX", (unsigned long)hr);
    if (FAILED(hr)) return;
    for (i = 0; IDXGIFactory1_EnumAdapters1(factory, i, &adapter) == S_OK; i++) {
        DXGI_ADAPTER_DESC1 desc;
        char name[128];
        IDXGIAdapter1_GetDesc1(adapter, &desc);
        WideCharToMultiByte(CP_ACP, 0, desc.Description, -1, name, sizeof name, NULL, NULL);
        LOG(BITS ": adapter %u: %s vendor=%04X device=%04X flags=%u vram=%uMB", i, name,
            desc.VendorId, desc.DeviceId, desc.Flags, (unsigned)(desc.DedicatedVideoMemory >> 20));
        IDXGIAdapter1_Release(adapter);
    }
    IDXGIFactory1_Release(factory);
}

static void probe_d3d11(void)
{
    static const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0,
        D3D_FEATURE_LEVEL_9_3, D3D_FEATURE_LEVEL_9_2, D3D_FEATURE_LEVEL_9_1,
    };
    UINT first, attempt;
    IDXGIFactory1 *factory = NULL;
    IDXGIAdapter1 *adapter = NULL;
    CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
    if (factory) IDXGIFactory1_EnumAdapters1(factory, 0, &adapter);
    /* attempts: with BGRA support (what DWM asks), without, and on adapter 0 by name */
    for (attempt = 0; attempt < 6; attempt++) {
        ID3D11Device *device = NULL;
        ID3D11DeviceContext *context = NULL;
        D3D_FEATURE_LEVEL got = 0;
        UINT flags = attempt % 3 == 0 ? D3D11_CREATE_DEVICE_BGRA_SUPPORT : 0;
        int explicit_adapter = attempt % 3 == 2;
        HRESULT hr;
        first = attempt < 3 ? 0 : 4;
        hr = D3D11CreateDevice(explicit_adapter ? (IDXGIAdapter *)adapter : NULL,
            explicit_adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, NULL, flags,
            levels + first, 7 - first, D3D11_SDK_VERSION, &device, &got, &context);
        LOG(BITS ": D3D11CreateDevice(%s, flags=%u, from level %u) -> 0x%08lX level 0x%x",
            explicit_adapter ? "adapter 0" : "HARDWARE", flags, first, (unsigned long)hr, got);
        if (SUCCEEDED(hr)) {
            D3D11_TEXTURE2D_DESC desc = {256, 256, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM, {1, 0}, D3D11_USAGE_DEFAULT,
                D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE, 0, 0};
            ID3D11Texture2D *texture = NULL;
            hr = ID3D11Device_CreateTexture2D(device, &desc, NULL, &texture);
            LOG(BITS ": CreateTexture2D(256x256 BGRA, target) -> 0x%08lX", (unsigned long)hr);
            if (texture) ID3D11Texture2D_Release(texture);
            ID3D11DeviceContext_Release(context);
            ID3D11Device_Release(device);
        }
    }
    LOG(BITS ": modules: loader=%p um=%p um10=%p", GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64_loader.dll" : "vm3dum_loader.dll"),
        GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64.dll" : "vm3dum.dll"), GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64_10.dll" : "vm3dum_10.dll"));
    if (adapter) IDXGIAdapter1_Release(adapter);
    if (factory) IDXGIFactory1_Release(factory);
}

/* The kernel thunks (gdi32): what dxgkrnl knows of the adapter */
typedef UINT D3DKMT_HANDLE;
typedef struct { LUID AdapterLuid; D3DKMT_HANDLE hAdapter; } OPENADAPTERFROMLUID;
typedef struct { D3DKMT_HANDLE hAdapter; UINT Type; void *pPrivateDriverData; UINT PrivateDriverDataSize; } QUERYADAPTERINFO;
typedef LONG (APIENTRY *OPEN_FN)(OPENADAPTERFROMLUID *);
typedef LONG (APIENTRY *QUERY_FN)(const QUERYADAPTERINFO *);
#define KMTQAITYPE_UMDRIVERNAME 1
#define KMTQAITYPE_DRIVERVERSION 13
#define KMTQAITYPE_ADAPTERTYPE 15

static void probe_kmt(void)
{
    HMODULE gdi = LoadLibraryA("gdi32.dll");
    OPEN_FN open = (OPEN_FN)GetProcAddress(gdi, "D3DKMTOpenAdapterFromLuid");
    QUERY_FN query = (QUERY_FN)GetProcAddress(gdi, "D3DKMTQueryAdapterInfo");
    IDXGIFactory1 *factory = NULL;
    IDXGIAdapter1 *adapter = NULL;
    DXGI_ADAPTER_DESC1 desc;
    OPENADAPTERFROMLUID opened;
    QUERYADAPTERINFO q;
    UINT value = 0, version;
    LONG status;
    if (!open || !query) { LOG(BITS ": no D3DKMT thunks"); return; }
    CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
    if (!factory || IDXGIFactory1_EnumAdapters1(factory, 0, &adapter) != S_OK) return;
    IDXGIAdapter1_GetDesc1(adapter, &desc);
    opened.AdapterLuid = desc.AdapterLuid;
    status = open(&opened);
    LOG(BITS ": D3DKMTOpenAdapterFromLuid -> 0x%08lX", (unsigned long)status);
    if (status) return;
    q.hAdapter = opened.hAdapter;
    q.Type = KMTQAITYPE_ADAPTERTYPE; q.pPrivateDriverData = &value; q.PrivateDriverDataSize = sizeof value;
    status = query(&q);
    LOG(BITS ": ADAPTERTYPE -> 0x%08lX flags=0x%x (render=%u display=%u software=%u post=%u)", (unsigned long)status, value,
        value & 1, value >> 1 & 1, value >> 2 & 1, value >> 3 & 1);
    q.Type = KMTQAITYPE_DRIVERVERSION; value = 0;
    status = query(&q);
    LOG(BITS ": DRIVERVERSION -> 0x%08lX wddm=%u", (unsigned long)status, value);
    for (version = 0; version < 3; version++) {
        struct { UINT Version; WCHAR UmdFileName[MAX_PATH]; } name;
        char text[MAX_PATH];
        name.Version = version; name.UmdFileName[0] = 0;
        q.Type = KMTQAITYPE_UMDRIVERNAME; q.pPrivateDriverData = &name; q.PrivateDriverDataSize = sizeof name;
        status = query(&q);
        WideCharToMultiByte(CP_ACP, 0, name.UmdFileName, -1, text, sizeof text, NULL, NULL);
        LOG(BITS ": UMDRIVERNAME(DX%u) -> 0x%08lX %s", version == 0 ? 9 : version == 1 ? 10 : 11, (unsigned long)status, text);
    }
    IDXGIAdapter1_Release(adapter);
    IDXGIFactory1_Release(factory);
}

/* The user-mode driver opened the way the D3D9 runtime does it (d3dumddi.h:
   OpenAdapter with the adapter callbacks), so its answer is ours to see */
typedef struct { void *pPrivateDriverData; UINT PrivateDriverDataSize; } QUERYADAPTERINFOCB_ARG;
typedef struct { UINT MultisampleCount; UINT Format; UINT *pMethodList; UINT MethodCount; } MSLIST_ARG;
typedef HRESULT (APIENTRY *QUERYCB_FN)(HANDLE, const QUERYADAPTERINFOCB_ARG *);
typedef HRESULT (APIENTRY *MSLISTCB_FN)(HANDLE, MSLIST_ARG *);
typedef struct { QUERYCB_FN pfnQueryAdapterInfoCb; MSLISTCB_FN pfnGetMultisampleMethodListCb; void *spare[6]; } ADAPTERCALLBACKS;
typedef struct { UINT Type; void *pInfo; void *pData; UINT DataSize; } GETCAPS_ARG;
typedef HRESULT (APIENTRY *GETCAPS_FN)(HANDLE, const GETCAPS_ARG *);
typedef HRESULT (APIENTRY *CLOSE_FN)(HANDLE);
typedef struct { GETCAPS_FN pfnGetCaps; void *pfnCreateDevice; CLOSE_FN pfnCloseAdapter; void *spare[6]; } ADAPTERFUNCS;
typedef struct { HANDLE hAdapter; UINT Interface; UINT Version; const ADAPTERCALLBACKS *pAdapterCallbacks;
    ADAPTERFUNCS *pAdapterFuncs; UINT DriverVersion; } OPENADAPTER_ARG;
typedef HRESULT (APIENTRY *OPENADAPTER_FN)(OPENADAPTER_ARG *);
#define KMTQAITYPE_UMDRIVERPRIVATE 0
#define D3DDDICAPS_GETFORMATCOUNT 3
#define D3DDDICAPS_GETFORMATDATA 4
#define D3DDDICAPS_GETD3D9CAPS 13

static QUERY_FN kmt_query;
static D3DKMT_HANDLE kmt_adapter;
static unsigned query_calls;

static HRESULT APIENTRY query_adapter_info_cb(HANDLE runtime, const QUERYADAPTERINFOCB_ARG *arg)
{
    QUERYADAPTERINFO q;
    LONG status;
    q.hAdapter = kmt_adapter; q.Type = KMTQAITYPE_UMDRIVERPRIVATE;
    q.pPrivateDriverData = arg->pPrivateDriverData; q.PrivateDriverDataSize = arg->PrivateDriverDataSize;
    status = kmt_query(&q);
    if (query_calls++ < 4) {
        const unsigned *d = arg->pPrivateDriverData;
        LOG(BITS ": UMD asks UMDRIVERPRIVATE size=%u -> 0x%08lX [%08x %08x %08x %08x %08x %08x %08x %08x]",
            arg->PrivateDriverDataSize, (unsigned long)status, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]);
    }
    return status ? E_FAIL : S_OK;
}

static HRESULT APIENTRY multisample_list_cb(HANDLE runtime, MSLIST_ARG *arg)
{
    LOG(BITS ": UMD asks multisample methods (count %u format %u)", arg->MultisampleCount, arg->Format);
    arg->MethodCount = 0;
    return S_OK;
}

static void probe_umd(void)
{
    static const UINT versions[] = { 0x4002, 0x3004, 0x2003, 0x000C };
    HMODULE gdi = LoadLibraryA("gdi32.dll");
    OPEN_FN open = (OPEN_FN)GetProcAddress(gdi, "D3DKMTOpenAdapterFromLuid");
    IDXGIFactory1 *factory = NULL;
    IDXGIAdapter1 *adapter = NULL;
    DXGI_ADAPTER_DESC1 desc;
    OPENADAPTERFROMLUID opened;
    QUERYADAPTERINFO q;
    struct { UINT Version; WCHAR UmdFileName[MAX_PATH]; } name;
    static unsigned char private_data[8192];
    char text[MAX_PATH];
    HMODULE umd;
    OPENADAPTER_FN open_adapter;
    LONG status;
    UINT i;
    kmt_query = (QUERY_FN)GetProcAddress(gdi, "D3DKMTQueryAdapterInfo");
    if (!open || !kmt_query) return;
    CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
    if (!factory || IDXGIFactory1_EnumAdapters1(factory, 0, &adapter) != S_OK) return;
    IDXGIAdapter1_GetDesc1(adapter, &desc);
    opened.AdapterLuid = desc.AdapterLuid;
    if (open(&opened)) return;
    kmt_adapter = opened.hAdapter;

    /* how big the private data is: the driver says so through a failure, or fills it */
    q.hAdapter = kmt_adapter; q.Type = KMTQAITYPE_UMDRIVERPRIVATE;
    for (i = 16; i <= sizeof private_data; i *= 2) {
        q.pPrivateDriverData = private_data; q.PrivateDriverDataSize = i;
        status = kmt_query(&q);
        if (!status) break;
    }
    LOG(BITS ": UMDRIVERPRIVATE fits in %u bytes -> 0x%08lX", i, (unsigned long)status);

    name.Version = 0; name.UmdFileName[0] = 0;
    q.Type = KMTQAITYPE_UMDRIVERNAME; q.pPrivateDriverData = &name; q.PrivateDriverDataSize = sizeof name;
    kmt_query(&q);
    WideCharToMultiByte(CP_ACP, 0, name.UmdFileName, -1, text, sizeof text, NULL, NULL);
    umd = LoadLibraryW(name.UmdFileName);
    LOG(BITS ": LoadLibrary(%s) -> %p error %lu", text, umd, umd ? 0ul : (unsigned long)GetLastError());
    if (!umd) return;
    open_adapter = (OPENADAPTER_FN)GetProcAddress(umd, "OpenAdapter");
    LOG(BITS ": OpenAdapter at %p", open_adapter);
    if (!open_adapter) return;
    for (i = 0; i < sizeof versions / sizeof versions[0]; i++) {
        ADAPTERCALLBACKS callbacks = { query_adapter_info_cb, multisample_list_cb };
        ADAPTERFUNCS funcs;
        OPENADAPTER_ARG arg;
        HRESULT hr;
        ZeroMemory(&funcs, sizeof funcs);
        arg.hAdapter = (HANDLE)(ULONG_PTR)0x1234; arg.Interface = 9; arg.Version = versions[i];
        arg.pAdapterCallbacks = &callbacks; arg.pAdapterFuncs = &funcs; arg.DriverVersion = 0;
        hr = open_adapter(&arg);
        LOG(BITS ": OpenAdapter(interface 9, version 0x%x) -> 0x%08lX driver version 0x%x", versions[i],
            (unsigned long)hr, arg.DriverVersion);
        LOG(BITS ": modules after: um=%p um10=%p", GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64.dll" : "vm3dum.dll"),
            GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64_10.dll" : "vm3dum_10.dll"));
        if (SUCCEEDED(hr) && funcs.pfnGetCaps) {
            static D3DCAPS9 caps;
            UINT formats = 0;
            GETCAPS_ARG c;
            c.Type = D3DDDICAPS_GETFORMATCOUNT; c.pInfo = NULL; c.pData = &formats; c.DataSize = sizeof formats;
            hr = funcs.pfnGetCaps(arg.hAdapter, &c);
            LOG(BITS ": GetCaps(FORMATCOUNT) -> 0x%08lX %u", (unsigned long)hr, formats);
            if (SUCCEEDED(hr) && formats && formats <= 256) {
                /* FORMATOP: format, D3DFORMAT_OP_* operations, flip and blt multisample types, bits */
                static unsigned ops[256 * 5];
                unsigned k;
                c.Type = D3DDDICAPS_GETFORMATDATA; c.pData = ops; c.DataSize = formats * 20;
                hr = funcs.pfnGetCaps(arg.hAdapter, &c);
                LOG(BITS ": GetCaps(FORMATDATA) -> 0x%08lX", (unsigned long)hr);
                for (k = 0; SUCCEEDED(hr) && k < formats; k += 4) {
                    LOG(BITS ":   fmt %u ops 0x%x | %u 0x%x | %u 0x%x | %u 0x%x", ops[5 * k], ops[5 * k + 1],
                        k + 1 < formats ? ops[5 * k + 5] : 0, k + 1 < formats ? ops[5 * k + 6] : 0,
                        k + 2 < formats ? ops[5 * k + 10] : 0, k + 2 < formats ? ops[5 * k + 11] : 0,
                        k + 3 < formats ? ops[5 * k + 15] : 0, k + 3 < formats ? ops[5 * k + 16] : 0);
                }
            }
            {
                /* every caps type the D3D9 runtime may ask, and what the driver says */
                static unsigned char info[256], data[16384];
                char text[400];
                unsigned type, n = 0;
                text[0] = 0;
                /* DDRAW, DDRAW_MODE_SPECIFIC, FORMATCOUNT, FORMATDATA, QUERYCOUNT,
                   QUERYDATA, D3D3..D3D9 caps: the runtime's questions at startup */
                static const unsigned types[] = { 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13 };
                unsigned t;
                for (t = 0; t < sizeof types / sizeof types[0]; t++) {
                    HRESULT r;
                    type = types[t];
                    ZeroMemory(info, sizeof info);
                    c.Type = type; c.pInfo = info; c.pData = data; c.DataSize = sizeof data;
                    r = funcs.pfnGetCaps(arg.hAdapter, &c);
                    if (FAILED(r)) n += wsprintfA(text + n, " %u:%08lX", type, (unsigned long)r);
                    if (n > 340) { LOG(BITS ": GetCaps failing types:%s", text); n = 0; text[0] = 0; }
                }
                LOG(BITS ": GetCaps failing types:%s", n ? text : " none");
            }
            c.pInfo = NULL;
            c.Type = D3DDDICAPS_GETD3D9CAPS; c.pData = &caps; c.DataSize = sizeof caps;
            hr = funcs.pfnGetCaps(arg.hAdapter, &c);
            LOG(BITS ": GetCaps(D3D9CAPS) -> 0x%08lX vs=0x%x ps=0x%x devcaps=0x%x caps2=0x%x primitive=0x%x raster=0x%x",
                (unsigned long)hr, (unsigned)caps.VertexShaderVersion, (unsigned)caps.PixelShaderVersion,
                (unsigned)caps.DevCaps, (unsigned)caps.Caps2, (unsigned)caps.PrimitiveMiscCaps, (unsigned)caps.RasterCaps);
            if (funcs.pfnCloseAdapter) funcs.pfnCloseAdapter(arg.hAdapter);
            break;
        }
    }
    IDXGIAdapter1_Release(adapter);
    IDXGIFactory1_Release(factory);
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    return DefWindowProcA(hwnd, message, wparam, lparam);
}

static void probe_d3d9(void)
{
    IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    D3DADAPTER_IDENTIFIER9 id;
    D3DCAPS9 caps;
    D3DPRESENT_PARAMETERS pp;
    IDirect3DDevice9 *device = NULL;
    WNDCLASSA wc = {0};
    HWND hwnd;
    HRESULT hr;
    if (!d3d) { LOG(BITS ": Direct3DCreate9 failed"); return; }
    hr = IDirect3D9_GetAdapterIdentifier(d3d, 0, 0, &id);
    LOG(BITS ": D3D9 adapter: %s (%s) -> 0x%08lX", id.Description, id.Driver, (unsigned long)hr);
    hr = IDirect3D9_GetDeviceCaps(d3d, 0, D3DDEVTYPE_HAL, &caps);
    LOG(BITS ": GetDeviceCaps(HAL) -> 0x%08lX vs=0x%x ps=0x%x", (unsigned long)hr,
        (unsigned)caps.VertexShaderVersion, (unsigned)caps.PixelShaderVersion);
    wc.lpfnWndProc = window_proc;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "d3dprobe";
    RegisterClassA(&wc);
    hwnd = CreateWindowA("d3dprobe", "d3dprobe", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, NULL, NULL, wc.hInstance, NULL);
    ZeroMemory(&pp, sizeof pp);
    pp.Windowed = TRUE;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferFormat = D3DFMT_UNKNOWN;
    pp.hDeviceWindow = hwnd;
    hr = IDirect3D9_CreateDevice(d3d, 0, D3DDEVTYPE_HAL, hwnd, D3DCREATE_HARDWARE_VERTEXPROCESSING, &pp, &device);
    LOG(BITS ": CreateDevice(HAL, windowed) -> 0x%08lX", (unsigned long)hr);
    if (device) {
        hr = IDirect3DDevice9_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xFF00FF00, 1.0f, 0);
        LOG(BITS ": Clear -> 0x%08lX", (unsigned long)hr);
        IDirect3DDevice9_Release(device);
    }
    IDirect3D9_Release(d3d);
}

/* The D3D10/11 entry (what DWM's D3D11 device goes through): the DDI
   versions the driver offers and the pipeline levels it reports */
typedef struct { void *hRTAdapter; void *hAdapter; UINT Interface; UINT Version;
    const ADAPTERCALLBACKS *pAdapterCallbacks; void *pAdapterFuncs; } OPENADAPTER10_ARG;
typedef HRESULT (APIENTRY *OPENADAPTER10_FN)(OPENADAPTER10_ARG *);
typedef HRESULT (APIENTRY *VERSIONS_FN)(void *, UINT *, unsigned long long *);
typedef HRESULT (APIENTRY *GETCAPS10_FN)(void *, const GETCAPS_ARG *);
typedef struct { void *pfnCalcPrivateDeviceSize; void *pfnCreateDevice; CLOSE_FN pfnCloseAdapter;
    VERSIONS_FN pfnGetSupportedVersions; GETCAPS10_FN pfnGetCaps; void *spare[8]; } ADAPTERFUNCS10_2;
#define D3D11DDICAPS_3DPIPELINESUPPORT 1026

static void probe_umd10(void)
{
    HMODULE umd = GetModuleHandleA(sizeof(void *) == 8 ? "vm3dum64_loader.dll" : "vm3dum_loader.dll");
    OPENADAPTER10_FN open10;
    ADAPTERCALLBACKS callbacks = { query_adapter_info_cb, multisample_list_cb };
    ADAPTERFUNCS10_2 funcs;
    OPENADAPTER10_ARG arg;
    unsigned long long versions[32];
    UINT count = 0, i, pipeline = 0;
    HRESULT hr;
    if (!umd || !kmt_adapter) return;
    open10 = (OPENADAPTER10_FN)GetProcAddress(umd, "OpenAdapter10_2");
    if (!open10) { LOG(BITS ": no OpenAdapter10_2"); return; }
    ZeroMemory(&funcs, sizeof funcs);
    arg.hRTAdapter = (void *)(ULONG_PTR)0x5678; arg.hAdapter = NULL;
    arg.Interface = 10 << 16 | 1; arg.Version = 4;
    arg.pAdapterCallbacks = &callbacks; arg.pAdapterFuncs = &funcs;
    hr = open10(&arg);
    LOG(BITS ": OpenAdapter10_2 -> 0x%08lX", (unsigned long)hr);
    if (FAILED(hr)) return;
    if (funcs.pfnGetSupportedVersions) {
        hr = funcs.pfnGetSupportedVersions(arg.hAdapter, &count, NULL);
        if (count > 32) count = 32;
        if (SUCCEEDED(hr)) hr = funcs.pfnGetSupportedVersions(arg.hAdapter, &count, versions);
        LOG(BITS ": GetSupportedVersions -> 0x%08lX, %u", (unsigned long)hr, count);
        for (i = 0; i < count; i++) LOG(BITS ":   DDI 0x%08x%08x", (unsigned)(versions[i] >> 32), (unsigned)versions[i]);
    }
    if (funcs.pfnGetCaps) {
        GETCAPS_ARG c;
        c.Type = D3D11DDICAPS_3DPIPELINESUPPORT; c.pInfo = NULL; c.pData = &pipeline; c.DataSize = sizeof pipeline;
        hr = funcs.pfnGetCaps(arg.hAdapter, &c);
        LOG(BITS ": GetCaps(3DPIPELINESUPPORT) -> 0x%08lX 0x%x", (unsigned long)hr, pipeline);
    }
}

void WINAPI entry(void)
{
    DWORD session = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &session);
    LOG(BITS ": start in session %lu", (unsigned long)session);
    probe_dxgi();
    probe_kmt();
    probe_umd();
    probe_d3d11();
    probe_d3d9();
    probe_umd10();
    LOG(BITS ": done");
    ExitProcess(0);
}
