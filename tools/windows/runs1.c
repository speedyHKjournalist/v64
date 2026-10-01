// runs1.exe: start a program in the console session (where the logon screen
// and DWM are), from the log agent, which runs as SYSTEM in session 0. With
// it, d3dprobe sees Direct3D the way DWM does, before anyone has signed in.
//
//   x86_64-w64-mingw32-gcc -O2 -nostdlib -e entry -o RUNS1.EXE runs1.c -ladvapi32 -luser32 -lkernel32
//
// runs1 <command line>: waits up to two minutes for it to end

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define MAGIC 0x564D5868u
#define PORT 0x5658u

static void backdoor(unsigned *a, unsigned *b, unsigned *c, unsigned *d)
{
    unsigned si = 0, di = 0;
    __asm__ volatile("inl %%dx, %%eax" : "+a"(*a), "+b"(*b), "+c"(*c), "+d"(*d), "+S"(si), "+D"(di) : : "memory");
}

/* one RPCI "log" line, as rpcilog.c sends them */
static void rpci_log(const char *text)
{
    unsigned a, b, c, d, channel, i, length = 4 + lstrlenA(text);
    char message[300];
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

static void fail(const char *step)
{
    char line[200];
    wsprintfA(line, "runs1: %s failed: error %lu", step, (unsigned long)GetLastError());
    rpci_log(line);
    ExitProcess(1);
}

static void enable(HANDLE token, const char *name)
{
    TOKEN_PRIVILEGES privileges;
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if (LookupPrivilegeValueA(NULL, name, &privileges.Privileges[0].Luid))
        AdjustTokenPrivileges(token, FALSE, &privileges, 0, NULL, NULL);
}

void WINAPI entry(void)
{
    char *line = GetCommandLineA();
    HANDLE token = NULL, primary = NULL;
    DWORD session = WTSGetActiveConsoleSessionId();
    STARTUPINFOA startup;
    PROCESS_INFORMATION process;
    int quoted = 0;
    // the program's own name, then its arguments
    for (; *line && (quoted || *line != ' '); line++) if (*line == '"') quoted = !quoted;
    while (*line == ' ') line++;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &token)) fail("OpenProcessToken");
    enable(token, "SeTcbPrivilege");
    enable(token, "SeAssignPrimaryTokenPrivilege");
    enable(token, "SeIncreaseQuotaPrivilege");
    if (!DuplicateTokenEx(token, MAXIMUM_ALLOWED, NULL, SecurityImpersonation, TokenPrimary, &primary)) fail("DuplicateTokenEx");
    if (!SetTokenInformation(primary, TokenSessionId, &session, sizeof session)) fail("SetTokenInformation");
    ZeroMemory(&startup, sizeof startup);
    startup.cb = sizeof startup;
    startup.lpDesktop = "winsta0\\winlogon";
    if (!CreateProcessAsUserA(primary, NULL, line, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) fail("CreateProcessAsUser");
    {
        char text[300];
        DWORD code = 0;
        wsprintfA(text, "runs1: started in session %lu: %s", (unsigned long)session, line);
        rpci_log(text);
        WaitForSingleObject(process.hProcess, 120000);
        GetExitCodeProcess(process.hProcess, &code);
        wsprintfA(text, "runs1: exit code 0x%lx", (unsigned long)code);
        rpci_log(text);
    }
    ExitProcess(0);
}
