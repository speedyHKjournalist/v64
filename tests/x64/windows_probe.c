/* Windows x64 qualification probe, built twice: x86_64 (native) and i686
 * (runs under WOW64, i.e. compatibility-mode code). No CRT. Results go
 * beside the executable on the disposable FAT16 test disk.
 *
 * Checks: the processor count and topology reported by the Windows
 * topology API (one package, N cores, one thread per core), threads pinned
 * to every processor run there (APIC ID from CPUID), interlocked work adds
 * up exactly, and (x64) memory placed above 4 GiB of virtual address space
 * is usable. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifdef _WIN64
#define ARCH "64"
#else
#define ARCH "32"
#endif
#define ROUNDS 64
static HANDLE result;
static volatile LONG shared_total, failed;
static DWORD system_cpus, checks[8], apic_seen[8];
static HANDLE threads[8];
static void text(const char *s) { DWORD n = 0, wrote; while(s[n]) n++; WriteFile(result, s, n, &wrote, 0); }
static void number(DWORD n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); text(b + i); }
static void hex(unsigned long long n) { char b[20]; int i = 19; b[i] = 0; do { b[--i] = "0123456789abcdef"[n & 15]; n >>= 4; } while(n); text(b + i); }
static DWORD apic_id(void) { DWORD a = 1, b, c = 0, d; __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d)); return b >> 24; }
static DWORD WINAPI worker(void *argument)
{
    DWORD id = (DWORD)(DWORD_PTR)argument;
    for(DWORD round = 0; round < ROUNDS; round++)
    {
        DWORD target = (id + round) % system_cpus;
        if(!SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)1 << target)) InterlockedIncrement(&failed);
        Sleep(0);
        DWORD seen = apic_id();
        if(seen >= 8) InterlockedIncrement(&failed);
        else InterlockedOr((LONG *)&apic_seen[target], 1 << seen);
        DWORD sum = 0, expected = 0;
        for(DWORD i = 1; i <= 1000; i++) sum += i ^ round;
        for(DWORD i = 1000; i; i--) expected += i ^ round;
        if(sum != expected || apic_id() != seen) InterlockedIncrement(&failed);
        InterlockedIncrement(&shared_total);
        checks[id]++;
    }
    return 0;
}
static void finish(DWORD code) { FlushFileBuffers(result); CloseHandle(result); ExitProcess(code); }
#ifdef _WIN64
void entry(void)
#else
void __attribute__((stdcall)) entry(void)
#endif
{
    char path[MAX_PATH];
    GetModuleFileNameA(0, path, sizeof(path));
    DWORD at = 0, last = 0;
    while(path[at]) { if(path[at] == '\\') last = at + 1; at++; }
    const char name[] = "RESULT" ARCH ".TXT";
    for(at = 0; at < sizeof(name); at++) path[last + at] = name[at];
    result = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if(result == INVALID_HANDLE_VALUE) ExitProcess(10);
    SYSTEM_INFO info;
    GetNativeSystemInfo(&info);
    system_cpus = info.dwNumberOfProcessors;
    text("X64_WIN_BEGIN arch=" ARCH " processors="); number(system_cpus);
    text(" architecture="); number(info.wProcessorArchitecture); text("\r\n");
    FlushFileBuffers(result);
    if(system_cpus < 1 || system_cpus > 8) finish(12);
    /* topology API */
    SYSTEM_LOGICAL_PROCESSOR_INFORMATION topology[64];
    DWORD bytes = sizeof(topology), packages = 0, cores = 0, smt = 0;
    if(!GetLogicalProcessorInformation(topology, &bytes)) finish(13);
    for(DWORD i = 0; i < bytes / sizeof(topology[0]); i++)
    {
        if(topology[i].Relationship == RelationProcessorPackage) packages++;
        if(topology[i].Relationship == RelationProcessorCore)
        {
            cores++;
            if(topology[i].ProcessorCore.Flags) smt++;
            DWORD_PTR mask = topology[i].ProcessorMask;
            if(mask == 0 || (mask & (mask - 1))) InterlockedIncrement(&failed); /* one logical processor per core */
        }
    }
    /* memory: x64 allocates top-down, far above 4 GiB */
    unsigned long long high = 0;
#ifdef _WIN64
    volatile unsigned long long *block = VirtualAlloc(0, 1 << 20, MEM_RESERVE | MEM_COMMIT | MEM_TOP_DOWN, PAGE_READWRITE);
    if(!block) finish(15);
    high = (unsigned long long)block;
    for(DWORD i = 0; i < (1 << 20) / 8; i += 512) block[i] = high ^ i;
    for(DWORD i = 0; i < (1 << 20) / 8; i += 512) if(block[i] != (high ^ i)) InterlockedIncrement(&failed);
    if(high >> 32 == 0) InterlockedIncrement(&failed);
    VirtualFree((void *)block, 0, MEM_RELEASE);
#endif
    for(DWORD id = 0; id < system_cpus; id++)
    {
        threads[id] = CreateThread(0, 0, worker, (void *)(DWORD_PTR)id, 0, 0);
        if(!threads[id]) finish(14);
    }
    if(WaitForMultipleObjects(system_cpus, threads, TRUE, 600000) != WAIT_OBJECT_0) finish(16);
    /* each processor ran on exactly one APIC ID, all distinct */
    DWORD all = 0;
    for(DWORD cpu = 0; cpu < system_cpus; cpu++)
    {
        DWORD mask = apic_seen[cpu];
        if(mask == 0 || (mask & (mask - 1)) || (all & mask)) InterlockedIncrement(&failed);
        all |= mask;
    }
    text("X64_WIN_DONE arch=" ARCH " processors="); number(system_cpus);
    text(" packages="); number(packages); text(" cores="); number(cores); text(" smt_cores="); number(smt);
    text(" progress="); number((DWORD)shared_total); text(" failures="); number((DWORD)failed);
    text(" apic_ids="); hex(all); text(" high_block="); hex(high); text(" checks=");
    for(DWORD id = 0; id < system_cpus; id++) { if(id) text(","); number(checks[id]); }
    text("\r\n");
    finish(failed ? 1 : 0);
}
