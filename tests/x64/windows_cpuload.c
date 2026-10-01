/* Desktop CPU load, as Windows itself accounts it (the numbers Task
 * Manager shows): per-processor idle/kernel/user/DPC/interrupt time and the
 * processes and threads that used the processor, over windows of WINDOW_MS
 * (6, or the number given on the command line). No CRT; x64 only. Results
 * go beside the executable (CPULOAD.TXT), one flushed block per window, then
 * CPULOAD_DONE. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define WINDOW_MS 10000
#define MAX_CPUS 8
#define TRACKED 1024
typedef LONG (WINAPI *query_fn)(ULONG, void *, ULONG, ULONG *);
typedef LONG (WINAPI *resolution_fn)(ULONG *, ULONG *, ULONG *);
static HANDLE result;
static query_fn query;
static void text(const char *s) { DWORD n = 0, wrote; while(s[n]) n++; WriteFile(result, s, n, &wrote, 0); }
static void number(unsigned long long n) { char b[24]; int i = 23; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); text(b + i); }
static void hex(unsigned long long n) { char b[20]; int i = 19; b[i] = 0; do { b[--i] = "0123456789abcdef"[n & 15]; n >>= 4; } while(n); text(b + i); }
/* tenths of a percent of a total */
static void permille(unsigned long long part, unsigned long long total)
{
    unsigned long long p = total ? part * 1000 / total : 0;
    number(p / 10); text("."); number(p % 10); text("%");
}
static void wide(const WCHAR *s, USHORT bytes)
{
    char b[64]; DWORD n = 0;
    for(; n < bytes / 2 && n < 63; n++) b[n] = s[n] < 128 ? (char)s[n] : '?';
    b[n] = 0;
    text(n ? b : "Idle");
}
/* SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION (class 8) */
typedef struct { LARGE_INTEGER idle, kernel, user, dpc, interrupt; ULONG interrupts; ULONG pad; } processor_times;
/* SYSTEM_INTERRUPT_INFORMATION (class 23) */
typedef struct { ULONG context_switches, dpc_count, dpc_rate, time_increment, dpc_bypass, apc_bypass; } interrupt_info;
static processor_times cpu_before[MAX_CPUS], cpu_after[MAX_CPUS];
static interrupt_info irq_before[MAX_CPUS], irq_after[MAX_CPUS];
/* per process and per thread: (id, 100 ns units) from the previous window */
typedef struct { unsigned long long id, time, cycles; } sample;
static sample processes[TRACKED], threads[TRACKED];
static DWORD process_count, thread_count;
static unsigned char buffer[1 << 20];
static unsigned long long previous(sample *table, DWORD count, unsigned long long id, unsigned long long *cycles)
{
    for(DWORD i = 0; i < count; i++) if(table[i].id == id) { if(cycles) *cycles = table[i].cycles; return table[i].time; }
    if(cycles) *cycles = 0;
    return 0;
}
typedef struct { unsigned long long delta, cycles, id, start; const WCHAR *name; USHORT name_bytes; } row;
static row top_processes[16], top_threads[16];
static void keep(row *top, row entry)
{
    for(int i = 0; i < 16; i++)
    {
        if(entry.delta > top[i].delta)
        {
            for(int j = 15; j > i; j--) top[j] = top[j - 1];
            top[i] = entry;
            return;
        }
    }
}
/* offsets in SYSTEM_PROCESS_INFORMATION / SYSTEM_THREAD_INFORMATION (x64) */
#define P_NEXT 0
#define P_THREADS 4
#define P_CYCLES 24
#define P_USER 40
#define P_KERNEL 48
#define P_NAME_LENGTH 56
#define P_NAME_BUFFER 64
#define P_PID 80
#define P_SIZE 0x100
#define T_KERNEL 0
#define T_USER 8
#define T_START 32
#define T_TID 48
#define T_SIZE 0x50
static int snapshot(int report, unsigned long long window)
{
    ULONG length = 0;
    if(query(5, buffer, sizeof(buffer), &length) < 0) return 0;
    static sample next_processes[TRACKED], next_threads[TRACKED];
    DWORD next_process_count = 0, next_thread_count = 0;
    for(int i = 0; i < 16; i++) { top_processes[i].delta = 0; top_threads[i].delta = 0; }
    for(unsigned char *p = buffer;; p += *(ULONG *)(p + P_NEXT))
    {
        unsigned long long pid = *(unsigned long long *)(p + P_PID);
        unsigned long long time = *(unsigned long long *)(p + P_USER) + *(unsigned long long *)(p + P_KERNEL);
        unsigned long long cycles = *(unsigned long long *)(p + P_CYCLES), cycles_before;
        const WCHAR *name = *(const WCHAR **)(p + P_NAME_BUFFER);
        USHORT name_bytes = *(USHORT *)(p + P_NAME_LENGTH);
        unsigned long long before = previous(processes, process_count, pid, &cycles_before);
        if(report) keep(top_processes, (row){time - before, cycles - cycles_before, pid, 0, name, name_bytes});
        if(next_process_count < TRACKED) next_processes[next_process_count++] = (sample){pid, time, cycles};
        ULONG count = *(ULONG *)(p + P_THREADS);
        for(ULONG t = 0; t < count; t++)
        {
            unsigned char *thread = p + P_SIZE + t * T_SIZE;
            unsigned long long tid = *(unsigned long long *)(thread + T_TID);
            unsigned long long ttime = *(unsigned long long *)(thread + T_USER) + *(unsigned long long *)(thread + T_KERNEL);
            unsigned long long tbefore = previous(threads, thread_count, tid, 0);
            /* (the idle threads all have id 0: report them per processor above) */
            if(report && pid) keep(top_threads, (row){ttime - tbefore, 0, pid << 32 | tid, *(unsigned long long *)(thread + T_START), name, name_bytes});
            if(next_thread_count < TRACKED) next_threads[next_thread_count++] = (sample){tid, ttime, 0};
        }
        if(!*(ULONG *)(p + P_NEXT)) break;
    }
    for(DWORD i = 0; i < next_process_count; i++) processes[i] = next_processes[i];
    for(DWORD i = 0; i < next_thread_count; i++) threads[i] = next_threads[i];
    process_count = next_process_count;
    thread_count = next_thread_count;
    if(!report) return 1;
    text(" processes (share of all processors' time; kernel+user; cycles):\r\n");
    for(int i = 0; i < 16 && top_processes[i].delta; i++)
    {
        text("  "); permille(top_processes[i].delta, window); text(" "); wide(top_processes[i].name, top_processes[i].name_bytes);
        text(" pid="); number(top_processes[i].id); text(" cycles="); number(top_processes[i].cycles); text("\r\n");
    }
    text(" threads:\r\n");
    for(int i = 0; i < 16 && top_threads[i].delta; i++)
    {
        text("  "); permille(top_threads[i].delta, window); text(" "); wide(top_threads[i].name, top_threads[i].name_bytes);
        text(" pid="); number(top_threads[i].id >> 32); text(" tid="); number(top_threads[i].id & 0xFFFFFFFF);
        text(" start=0x"); hex(top_threads[i].start); text("\r\n");
    }
    return 1;
}
static void finish(DWORD code) { FlushFileBuffers(result); CloseHandle(result); ExitProcess(code); }
void entry(void)
{
    char path[MAX_PATH];
    GetModuleFileNameA(0, path, sizeof(path));
    DWORD at = 0, last = 0;
    while(path[at]) { if(path[at] == '\\') last = at + 1; at++; }
    const char name[] = "CPULOAD.TXT";
    for(at = 0; at < sizeof(name); at++) path[last + at] = name[at];
    result = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if(result == INVALID_HANDLE_VALUE) ExitProcess(10);
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    query = (query_fn)GetProcAddress(ntdll, "NtQuerySystemInformation");
    resolution_fn resolution = (resolution_fn)GetProcAddress(ntdll, "NtQueryTimerResolution");
    if(!query) finish(11);
    int rounds = 0;
    for(const char *c = GetCommandLineA(); *c; c++) rounds = *c >= '0' && *c <= '9' ? rounds * 10 + (*c - '0') : 0;
    if(rounds <= 0) rounds = 6;
    SYSTEM_INFO info;
    GetNativeSystemInfo(&info);
    DWORD cpus = info.dwNumberOfProcessors > MAX_CPUS ? MAX_CPUS : info.dwNumberOfProcessors;
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    ULONG coarsest = 0, finest = 0, current = 0;
    if(resolution) resolution(&coarsest, &finest, &current);
    text("CPULOAD_BEGIN processors="); number(cpus); text(" qpc_hz="); number(frequency.QuadPart);
    text(" timer_100ns(coarsest,finest,current)="); number(coarsest); text(","); number(finest); text(","); number(current);
    text(" uptime_ms="); number(GetTickCount64()); text("\r\n");
    FlushFileBuffers(result);
    ULONG length;
    query(8, cpu_before, sizeof(processor_times) * cpus, &length);
    query(23, irq_before, sizeof(interrupt_info) * cpus, &length);
    snapshot(0, 0);
    for(int round = 0; round < rounds; round++)
    {
        LARGE_INTEGER q0, q1;
        QueryPerformanceCounter(&q0);
        Sleep(WINDOW_MS);
        QueryPerformanceCounter(&q1);
        query(8, cpu_after, sizeof(processor_times) * cpus, &length);
        query(23, irq_after, sizeof(interrupt_info) * cpus, &length);
        unsigned long long all = 0, idle_all = 0;
        text("CPULOAD_WINDOW round="); number(round); text(" qpc_ms="); number((q1.QuadPart - q0.QuadPart) * 1000 / frequency.QuadPart);
        text(" uptime_ms="); number(GetTickCount64()); text("\r\n");
        for(DWORD c = 0; c < cpus; c++)
        {
            /* kernel time includes idle time */
            unsigned long long idle = cpu_after[c].idle.QuadPart - cpu_before[c].idle.QuadPart;
            unsigned long long kernel = cpu_after[c].kernel.QuadPart - cpu_before[c].kernel.QuadPart;
            unsigned long long user = cpu_after[c].user.QuadPart - cpu_before[c].user.QuadPart;
            unsigned long long dpc = cpu_after[c].dpc.QuadPart - cpu_before[c].dpc.QuadPart;
            unsigned long long interrupt = cpu_after[c].interrupt.QuadPart - cpu_before[c].interrupt.QuadPart;
            unsigned long long total = kernel + user;
            all += total; idle_all += idle;
            text(" cpu"); number(c); text(" busy="); permille(total - idle, total);
            text(" user="); permille(user, total); text(" kernel="); permille(kernel - idle, total);
            text(" dpc="); permille(dpc, total); text(" interrupt="); permille(interrupt, total);
            text(" interrupts="); number(cpu_after[c].interrupts - cpu_before[c].interrupts);
            text(" dpcs="); number(irq_after[c].dpc_count - irq_before[c].dpc_count);
            text(" switches="); number(irq_after[c].context_switches - irq_before[c].context_switches);
            text(" total_ms="); number(total / 10000); text("\r\n");
            cpu_before[c] = cpu_after[c];
            irq_before[c] = irq_after[c];
        }
        text(" all busy="); permille(all - idle_all, all); text("\r\n");
        snapshot(1, all);
        FlushFileBuffers(result);
    }
    text("CPULOAD_DONE\r\n");
    finish(0);
}
