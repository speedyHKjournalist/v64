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
    UINT first;
    for (first = 0; first < 7; first += 4) {
        ID3D11Device *device = NULL;
        ID3D11DeviceContext *context = NULL;
        D3D_FEATURE_LEVEL got = 0;
        HRESULT hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            levels + first, 7 - first, D3D11_SDK_VERSION, &device, &got, &context);
        LOG(BITS ": D3D11CreateDevice(HARDWARE, from level %u) -> 0x%08lX level 0x%x", first, (unsigned long)hr, got);
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

void WINAPI entry(void)
{
    LOG(BITS ": start");
    probe_dxgi();
    probe_d3d11();
    probe_d3d9();
    LOG(BITS ": done");
    ExitProcess(0);
}
