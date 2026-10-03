// dbwin.exe: what programs in its session write with OutputDebugString, sent
// to the host as VMware RPCI "log" lines ("dbwin <pid>: <text>"), the way a
// debugger's DBWIN window reads them. Direct3D 9's shader and declaration
// validators, for one, say there why a call failed (with
// HKLM\Software\Microsoft\Direct3D EnableDebugging = 1).
//
//   x86_64-w64-mingw32-gcc -O2 -nostdlib -e entry -mwindows -o DBWIN.EXE dbwin.c -lkernel32
//
// v86 lets user mode use the backdoor port, as VMware does.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define MAGIC 0x564D5868u
#define PORT 0x5658u
#define MESSAGE 30u

static void backdoor(unsigned *a, unsigned *b, unsigned *c, unsigned *d)
{
    unsigned si = 0, di = 0;
    __asm__ volatile("inl %%dx, %%eax" : "+a"(*a), "+b"(*b), "+c"(*c), "+d"(*d), "+S"(si), "+D"(di) : : "memory");
}

/* One RPCI request; the reply is read and dropped */
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

static char line[600];

void entry(void)
{
    HANDLE buffer_ready = CreateEventA(NULL, FALSE, FALSE, "DBWIN_BUFFER_READY");
    HANDLE data_ready = CreateEventA(NULL, FALSE, FALSE, "DBWIN_DATA_READY");
    HANDLE map = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, 4096, "DBWIN_BUFFER");
    const char *view = map ? (const char *)MapViewOfFile(map, FILE_MAP_READ, 0, 0, 4096) : NULL;
    if (!buffer_ready || !data_ready || !view) {
        rpci("log dbwin: cannot open the DBWIN objects", 40);
        ExitProcess(1);
    }
    rpci("log dbwin: ready", 16);
    for (;;) {
        DWORD pid, n, i;
        SetEvent(buffer_ready);
        if (WaitForSingleObject(data_ready, INFINITE) != WAIT_OBJECT_0) continue;
        pid = *(const DWORD *)view;
        lstrcpyA(line, "log dbwin ");
        n = lstrlenA(line);
        /* the pid in decimal */
        {
            char digits[12];
            int k = 0;
            do { digits[k++] = (char)('0' + pid % 10); pid /= 10; } while (pid);
            while (k) line[n++] = digits[--k];
        }
        line[n++] = ':';
        line[n++] = ' ';
        for (i = 4; i < 4096 && view[i] && n < sizeof line - 1; i++) {
            char ch = view[i];
            if (ch == '\r' || ch == '\n') ch = ' ';
            if ((unsigned char)ch >= 32 && (unsigned char)ch < 127) line[n++] = ch;
        }
        rpci(line, n);
    }
}
