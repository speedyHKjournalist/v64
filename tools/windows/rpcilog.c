// rpcilog.exe <file>: send a text file's lines to the host as VMware RPCI
// "log" messages (src/vmware.js turns them into vmware-log events, which
// tests/x64/windows_boot.mjs prints). A way to read what a Windows guest
// knows -- event logs, process lists -- when its screen shows nothing.
//
//   x86_64-w64-mingw32-gcc -O2 -nostdlib -e entry -o RPCILOG.EXE rpcilog.c -lkernel32
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
static int rpci(const char *text, unsigned length)
{
    unsigned a, b, c, d, channel, i;
    a = MAGIC; b = 0x49435052u | 0x80000000u; c = MESSAGE; d = PORT;
    backdoor(&a, &b, &c, &d);
    if (!((c >> 16) & 1)) return 0;
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
    return 1;
}

static char buffer[1 << 20];
static char line[512];

void entry(void)
{
    char *command = GetCommandLineA();
    char *path;
    HANDLE file;
    DWORD got = 0, i, n = 0;
    /* the first argument after the program name */
    if (*command == '"') { command++; while (*command && *command != '"') command++; if (*command) command++; }
    else while (*command && *command != ' ') command++;
    while (*command == ' ') command++;
    path = command;
    file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) { rpci("log rpcilog: cannot open file", 29); ExitProcess(1); }
    ReadFile(file, buffer, sizeof buffer - 1, &got, NULL);
    CloseHandle(file);
    lstrcpyA(line, "log ");
    n = 4;
    for (i = 0; i <= got; i++) {
        char ch = i < got ? buffer[i] : '\n';
        if (ch == '\r') continue;
        if (ch == '\n' || n >= sizeof line - 1) {
            if (n > 4) rpci(line, n);
            n = 4;
            continue;
        }
        if ((unsigned char)ch >= 32 && (unsigned char)ch < 127) line[n++] = ch;
    }
    ExitProcess(0);
}
