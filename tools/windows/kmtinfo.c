// kmtinfo.exe: what VMware's kernel driver (vm3dmp.sys) hands its user-mode
// drivers, sent to the host as VMware RPCI "log" lines: the private adapter
// info D3DKMTQueryAdapterInfo(UMDRIVERPRIVATE) returns, 0x47c bytes of it
// for the D3D10/11 driver. In it: a flags word at 0x10 (0x100: feature level
// 10_1 allowed, 0x400: 11_0), SVGA_REG_CAPABILITIES at 4, CAP2 at 8, and
// from 0x64 the 0x106 devcaps as the kernel driver read them.
//
//   x86_64-w64-mingw32-gcc -O2 -mwindows -o KMTINFO.EXE kmtinfo.c -ldxgi -ldxguid
//
// v86 lets user mode use the backdoor port, as VMware does.

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <dxgi.h>
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

static void say(const char *text)
{
    char line[700];
    snprintf(line, sizeof line, "log kmtinfo: %s", text);
    rpci(line, (unsigned)strlen(line));
}

typedef UINT D3DKMT_HANDLE;
typedef struct { LUID AdapterLuid; D3DKMT_HANDLE hAdapter; } OPENADAPTERFROMLUID;
typedef struct { D3DKMT_HANDLE hAdapter; UINT Type; void *pPrivateDriverData; UINT PrivateDriverDataSize; } QUERYADAPTERINFO;
typedef LONG (APIENTRY *OPEN_FN)(OPENADAPTERFROMLUID *);
typedef LONG (APIENTRY *QUERY_FN)(const QUERYADAPTERINFO *);
#define KMTQAITYPE_UMDRIVERPRIVATE 0
#define INFO_SIZE 0x47c
#define DEVCAPS 0x106

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command_line, int show)
{
    HMODULE gdi = LoadLibraryA("gdi32.dll");
    OPEN_FN open = (OPEN_FN)GetProcAddress(gdi, "D3DKMTOpenAdapterFromLuid");
    QUERY_FN query = (QUERY_FN)GetProcAddress(gdi, "D3DKMTQueryAdapterInfo");
    IDXGIFactory1 *factory = NULL;
    IDXGIAdapter1 *adapter = NULL;
    DXGI_ADAPTER_DESC1 desc;
    OPENADAPTERFROMLUID opened;
    QUERYADAPTERINFO q;
    static unsigned info[INFO_SIZE / 4];
    char text[700];
    LONG status;
    int i, n;
    if (!open || !query) { say("no D3DKMT thunks"); return 1; }
    CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
    if (!factory || IDXGIFactory1_EnumAdapters1(factory, 0, &adapter) != S_OK) { say("no adapter"); return 1; }
    IDXGIAdapter1_GetDesc1(adapter, &desc);
    opened.AdapterLuid = desc.AdapterLuid;
    if ((status = open(&opened))) { snprintf(text, sizeof text, "open 0x%08lx", (unsigned long)status); say(text); return 1; }
    q.hAdapter = opened.hAdapter; q.Type = KMTQAITYPE_UMDRIVERPRIVATE;
    q.pPrivateDriverData = info; q.PrivateDriverDataSize = INFO_SIZE;
    status = query(&q);
    snprintf(text, sizeof text, "UMDRIVERPRIVATE(0x%x) -> 0x%08lx; [0]=%08x caps=%08x cap2=%08x [3]=%08x flags=%08x [5]=%08x",
        INFO_SIZE, (unsigned long)status, info[0], info[1], info[2], info[3], info[4], info[5]);
    say(text);
    if (status) return 1;
    /* the devcaps, 16 to a line, as "index:value" for the ones not 0 */
    for (i = 0; i < DEVCAPS; ) {
        n = snprintf(text, sizeof text, "devcaps from %u:", i);
        for (; i < DEVCAPS && n < (int)sizeof text - 24; i++) {
            unsigned value = info[0x64 / 4 + i];
            if (value) n += snprintf(text + n, sizeof text - n, " %x:%x", i, value);
            if ((i & 31) == 31) { i++; break; }
        }
        say(text);
    }
    say("end");
    return 0;
}
