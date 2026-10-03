// launch.exe: runs the command lines the host gives it, in the session it was
// started in. Started once as the signed-in user (from the Run dialog), it
// lets a test harness start programs that need the user's desktop -- D3D9
// apps, for one -- without typing into the Run dialog, which loses keys
// while the guest is busy.
//
// It asks for "guestinfo.v86.run" through the VMware backdoor once a second.
// A value is "<serial> <command line>"; each new serial runs its line with
// cmd /c (tests/x64/windows_boot.mjs: "launch <command line>").
//
//   x86_64-w64-mingw32-gcc -O2 -nostdlib -e entry -mwindows -o LAUNCH.EXE launch.c -lkernel32
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

/* One RPCI request; up to max - 1 bytes of the reply, 0-terminated.
   Returns the reply's length, or -1 */
static int rpci(const char *text, unsigned length, char *reply, unsigned max)
{
    unsigned a, b, c, d, channel, i, size = 0;
    a = MAGIC; b = 0x49435052u | 0x80000000u; c = MESSAGE; d = PORT;
    backdoor(&a, &b, &c, &d);
    if (!((c >> 16) & 1)) return -1;
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
        size = b;
        for (i = 0; i < size; i += 4) {
            unsigned j;
            a = MAGIC; b = 1; c = 4u << 16 | MESSAGE; d = channel << 16 | PORT;
            backdoor(&a, &b, &c, &d);
            for (j = 0; j < 4 && i + j < size; j++) if (i + j < max - 1) reply[i + j] = (char)(b >> 8 * j);
        }
        a = MAGIC; b = 1; c = 5u << 16 | MESSAGE; d = channel << 16 | PORT;
        backdoor(&a, &b, &c, &d);
    }
    a = MAGIC; b = 0; c = 6u << 16 | MESSAGE; d = channel << 16 | PORT;
    backdoor(&a, &b, &c, &d);
    if (size > max - 1) size = max - 1;
    reply[size] = 0;
    return (int)size;
}

static void log_line(const char *text)
{
    static char line[600];
    char discard[16];
    lstrcpyA(line, "log launch: ");
    lstrcpynA(line + 12, text, sizeof line - 12);
    rpci(line, lstrlenA(line), discard, sizeof discard);
}

static char reply[4096], last[4096], command[4200];

void entry(void)
{
    static const char ask[] = "info-get guestinfo.v86.run";
    log_line("ready");
    for (;;) {
        int n = rpci(ask, sizeof ask - 1, reply, sizeof reply);
        /* "1 <serial> <line>" when there is a value */
        if (n > 2 && reply[0] == '1' && lstrcmpA(reply, last)) {
            const char *line = reply + 2;
            STARTUPINFOA startup;
            PROCESS_INFORMATION process;
            lstrcpyA(last, reply);
            while (*line && *line != ' ') line++;
            while (*line == ' ') line++;
            lstrcpyA(command, "cmd /c ");
            lstrcpynA(command + 7, line, sizeof command - 7);
            ZeroMemory(&startup, sizeof startup);
            startup.cb = sizeof startup;
            if (CreateProcessA(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, "C:\\", &startup, &process)) {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                log_line(reply + 2);
            } else {
                log_line("CreateProcess failed");
            }
        }
        Sleep(1000);
    }
}
