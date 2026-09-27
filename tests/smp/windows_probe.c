/* XP-compatible, no CRT. A Win32 SMP qualification probe, not a CPU-info test.
 * Results go beside the executable on the disposable FAT16 test disk. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static HANDLE result;
static volatile LONG shared_total;
static DWORD system_cpus, failed, checks[8];
static HANDLE threads[8];
static void text(const char *s) { DWORD n = 0, wrote; while(s[n]) n++; WriteFile(result,s,n,&wrote,0); }
static void number(DWORD n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); text(b + i); }
static DWORD apic_id(void) { DWORD a = 1, b, c, d; __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "=c"(c), "=d"(d)); return b >> 24; }
static DWORD WINAPI worker(void *argument)
{
    DWORD id = (DWORD)argument;
    for(DWORD round = 0; round < 128; round++)
    {
        DWORD target = (id + round) % system_cpus;
        if(!SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)1 << target) || apic_id() != target) InterlockedIncrement((LONG *)&failed);
        DWORD sum = 0;
        for(DWORD i = 1; i <= 1000; i++) sum += i ^ round;
        DWORD expected = 0;
        for(DWORD i = 1000; i; i--) expected += i ^ round;
        if(sum != expected || apic_id() != target) InterlockedIncrement((LONG *)&failed);
        InterlockedIncrement(&shared_total);
        checks[id]++;
        Sleep(0);
    }
    return 0;
}
void __attribute__((stdcall)) entry(void)
{
    char path[MAX_PATH];
    GetModuleFileNameA(0,path,sizeof(path));
    DWORD at = 0, last = 0;
    while(path[at]) { if(path[at] == '\\') last = at + 1; at++; }
    const char name[] = "RESULT.TXT";
    for(at = 0; at < sizeof(name); at++) path[last + at] = name[at];
    result = CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(result == INVALID_HANDLE_VALUE) ExitProcess(10);
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    DWORD_PTR process_mask = 0, machine_mask = 0;
    if(!GetProcessAffinityMask(GetCurrentProcess(), &process_mask, &machine_mask)) ExitProcess(11);
    system_cpus = info.dwNumberOfProcessors;
    text("C3_XP_BEGIN processors="); number(system_cpus); text(" process_mask="); number((DWORD)process_mask); text(" machine_mask="); number((DWORD)machine_mask); text("\r\n");
    FlushFileBuffers(result);
    if(system_cpus < 1 || system_cpus > 8) ExitProcess(12);
    for(DWORD id = 0; id < system_cpus; id++)
    {
        threads[id] = CreateThread(0,0,worker,(void *)id,0,0);
        if(!threads[id]) ExitProcess(13);
    }
    if(WaitForMultipleObjects(system_cpus,threads,TRUE,120000) != WAIT_OBJECT_0) ExitProcess(14);
    text("C3_XP_DONE processors="); number(system_cpus); text(" progress="); number((DWORD)shared_total); text(" failures="); number(failed); text(" checks=");
    for(DWORD id = 0; id < system_cpus; id++) { if(id) text(","); number(checks[id]); }
    text("\r\n"); FlushFileBuffers(result); CloseHandle(result);
    ExitProcess(failed ? 1 : 0);
}
