/* Freestanding Linux user probe, built once for x86_64 and once for i386 so
 * the same checks run as a native 64-bit process and as a compatibility-mode
 * process under an x86_64 kernel: raw system calls, uname, mmap/mprotect with
 * a SIGSEGV round trip, fork/pipe/wait4, CLONE_THREAD threads bound to every
 * online CPU with LOCKed counters, a cross-CPU TLB shootdown after MAP_FIXED,
 * tmpfs file I/O, and the physical placement of 16 MiB of touched pages
 * (how many frames lie above 4 GiB, from /proc/self/pagemap). A second line
 * (X64_PROBE_XC) covers the multicore matrix: /sys topology, thread
 * migration, signals to threads on other CPUs, cross-modifying code
 * executed on another CPU, and an O_DIRECT read of the disk. No libc. */
#if defined(__x86_64__)
typedef long word;
enum { SYS_read = 0, SYS_write = 1, SYS_open = 2, SYS_close = 3, SYS_lseek = 8, SYS_mmap = 9,
    SYS_mprotect = 10, SYS_rt_sigaction = 13, SYS_pipe = 22, SYS_sched_yield = 24, SYS_getpid = 39,
    SYS_clone = 56, SYS_fork = 57, SYS_exit = 60, SYS_wait4 = 61, SYS_uname = 63, SYS_unlink = 87,
    SYS_sched_setaffinity = 203, SYS_sched_getaffinity = 204, SYS_exit_group = 231, SYS_getcpu = 309,
    SYS_gettid = 186, SYS_tgkill = 234 };
#define ARCH "64"
#define SIGINFO_ADDR 16
static word sc(word n, word a, word b, word c, word d, word e, word f)
{
    word r;
    register word r10 __asm__("r10") = d;
    register word r8 __asm__("r8") = e;
    register word r9 __asm__("r9") = f;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory", "cc");
    return r;
}
__asm__(".text\n.global signal_return\nsignal_return:\nmov $15,%eax\nsyscall\nud2\n"
    /* spawn(fn, arg, stack_top, flags): the child pops fn/arg off its stack. */
    ".global spawn\nspawn:\nsub $16,%rdx\nmov %rdi,(%rdx)\nmov %rsi,8(%rdx)\nmov %rdx,%rsi\nmov %rcx,%rdi\n"
    "xor %edx,%edx\nxor %r10d,%r10d\nxor %r8d,%r8d\nmov $56,%eax\nsyscall\ntest %rax,%rax\njnz 1f\n"
    "pop %rax\npop %rdi\ncall *%rax\nxor %edi,%edi\nmov $60,%eax\nsyscall\nud2\n1:\nret\n"
    ".global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall entry\nud2\n");
static word *mapping(word length, int prot)
{
    return (word *)sc(SYS_mmap, 0, length, prot, 0x22, -1, 0);
}
/* MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED over an existing page */
static word remap(word address)
{
    return sc(SYS_mmap, address, 4096, 3, 0x32, -1, 0);
}
#else
typedef int word;
enum { SYS_exit = 1, SYS_fork = 2, SYS_read = 3, SYS_write = 4, SYS_open = 5, SYS_close = 6,
    SYS_unlink = 10, SYS_lseek = 19, SYS_getpid = 20, SYS_pipe = 42, SYS_old_mmap = 90, SYS_wait4 = 114,
    SYS_clone = 120, SYS_uname = 122, SYS_mprotect = 125, SYS_sched_yield = 158, SYS_rt_sigaction = 174,
    SYS_sched_setaffinity = 241, SYS_sched_getaffinity = 242, SYS_exit_group = 252, SYS_getcpu = 318,
    SYS_gettid = 224, SYS_tgkill = 270 };
#define ARCH "32"
#define SIGINFO_ADDR 12
static word sc(word n, word a, word b, word c, word d, word e, word f)
{
    word r;
    (void)f;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c), "S"(d), "D"(e) : "memory", "cc");
    return r;
}
__asm__(".text\n.global signal_return\nsignal_return:\nmov $173,%eax\nint $0x80\nud2\n"
    ".global spawn\nspawn:\npush %ebx\npush %esi\npush %edi\nmov 24(%esp),%ecx\nsub $8,%ecx\n"
    "mov 16(%esp),%eax\nmov %eax,(%ecx)\nmov 20(%esp),%eax\nmov %eax,4(%ecx)\nmov 28(%esp),%ebx\n"
    "xor %edx,%edx\nxor %esi,%esi\nxor %edi,%edi\nmov $120,%eax\nint $0x80\ntest %eax,%eax\njnz 1f\n"
    "pop %eax\npop %edx\npush %edx\ncall *%eax\nxor %ebx,%ebx\nmov $1,%eax\nint $0x80\nud2\n"
    "1:\npop %edi\npop %esi\npop %ebx\nret\n"
    ".global _start\n_start:\nmov %esp,%eax\nand $-16,%esp\nsub $12,%esp\npush %eax\ncall entry\nud2\n");
/* old_mmap takes its six arguments from memory. */
static word *mapping(word length, int prot)
{
    word args[6] = {0, length, prot, 0x22, -1, 0};
    return (word *)sc(SYS_old_mmap, (word)args, 0, 0, 0, 0, 0);
}
static word remap(word address)
{
    word args[6] = {address, 4096, 3, 0x32, -1, 0};
    return sc(SYS_old_mmap, (word)args, 0, 0, 0, 0, 0);
}
#endif
#define S(n, a, b, c) sc(n, (word)(a), (word)(b), (word)(c), 0, 0, 0)

void *memset(void *d, int v, unsigned long n) { unsigned char *p = d; while(n--) *p++ = (unsigned char)v; return d; }
void *memcpy(void *d, const void *s, unsigned long n) { unsigned char *p = d; const unsigned char *q = s; while(n--) *p++ = *q++; return d; }
extern void signal_return(void);
extern word spawn(void (*fn)(word), word arg, void *stack_top, word flags);

static int length(const char *s) { int n = 0; while(s[n]) n++; return n; }
static void out(const char *s) { S(SYS_write, 1, s, length(s)); }
static void number(unsigned long n) { char b[24]; int i = 23; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); out(b + i); }
static void die(const char *s) { out("X64_PROBE_FAIL arch=" ARCH " "); out(s); out("\n"); S(SYS_exit_group, 1, 0, 0); for(;;); }
static word check(word n, const char *s) { if(n < 0 && n > -4096) die(s); return n; }
static int same(const char *a, const char *b) { while(*a && *a == *b) { a++; b++; } return *a == *b; }

static volatile word fault_address;
static volatile word *protected_page;
static void segv(int sig, void *info, void *context)
{
    (void)sig; (void)context;
    fault_address = *(word *)((char *)info + SIGINFO_ADDR);
    check(S(SYS_mprotect, protected_page, 4096, 3), "mprotect restore");
}

#define THREADS 8
#define ITERATIONS 20000
static unsigned cpus;
static volatile unsigned counter, finished, bound[THREADS];
/* TLB shootdown: every worker keeps a translation of `watched` live on its
 * CPU; the main thread then replaces the page with MAP_FIXED. Once mmap has
 * returned, no CPU may still read the old frame. */
static volatile word *watched;
static volatile unsigned readers, remapped, stale;
static char stacks[THREADS][16384] __attribute__((aligned(16)));
static void worker(word id)
{
    unsigned long mask = 1ul << (id % cpus);
    unsigned cpu = ~0u;
    check(S(SYS_sched_setaffinity, 0, sizeof(mask), &mask), "thread affinity");
    check(S(SYS_getcpu, &cpu, 0, 0), "getcpu");
    if(cpu != id % cpus) die("thread migration");
    bound[id] = cpu + 1;
    for(int i = 0; i < ITERATIONS; i++)
    {
        __asm__ volatile("lock addl $1,%0" : "+m"(counter) :: "memory", "cc");
        if((i & 1023) == 0) S(SYS_sched_yield, 0, 0, 0);
    }
    word seen = 0;
    __asm__ volatile("lock addl $1,%0" : "+m"(readers) :: "memory", "cc");
    while(!remapped) seen += *watched;
    if(*watched != 2) __asm__ volatile("lock addl $1,%0" : "+m"(stale) :: "memory", "cc");
    (void)seen;
    __asm__ volatile("lock addl $1,%0" : "+m"(finished) :: "memory", "cc");
}

/* Multicore matrix (X64_PROBE_XC). */
#define MIGRATIONS 24
#define SIGNALS 16
#define SMC_ROUNDS 64
static volatile word tids[THREADS];
static volatile unsigned signalled[THREADS], moved[THREADS], xc_done, xc_ready;
static volatile unsigned smc_sequence, smc_ack, smc_bad;
/* not the first phase's stacks: an exiting thread still returns through its own */
static char xc_stacks[THREADS][16384] __attribute__((aligned(16)));
static unsigned char *smc_code;
static void rt_signal(int sig, void *info, void *context)
{
    (void)sig; (void)info; (void)context;
    word tid = S(SYS_gettid, 0, 0, 0);
    for(unsigned id = 0; id < THREADS; id++)
        if(tids[id] == tid) __asm__ volatile("lock addl $1,%0" : "+m"(signalled[id]) :: "memory", "cc");
}
static void set_cpu(unsigned cpu)
{
    unsigned long mask = 1ul << cpu;
    check(S(SYS_sched_setaffinity, 0, sizeof(mask), &mask), "affinity");
}
static void xc_worker(word id)
{
    tids[id] = S(SYS_gettid, 0, 0, 0);
    /* migration: every step lands on the requested CPU */
    for(unsigned k = 0; k < MIGRATIONS; k++)
    {
        unsigned target = (id + k) % cpus, cpu = ~0u;
        set_cpu(target);
        check(S(SYS_getcpu, &cpu, 0, 0), "getcpu");
        if(cpu != target) die("migration");
        __asm__ volatile("lock addl $1,%0" : "+m"(moved[id]) :: "memory", "cc");
    }
    set_cpu(id % cpus);
    __asm__ volatile("lock addl $1,%0" : "+m"(xc_ready) :: "memory", "cc");
    /* signals from the main thread on another CPU */
    while(signalled[id] < SIGNALS) S(SYS_sched_yield, 0, 0, 0);
    /* the last worker executes code that the main thread rewrites */
    if(id == cpus - 1)
    {
        for(unsigned round = 1; round <= SMC_ROUNDS; round++)
        {
            while(smc_sequence != round) S(SYS_sched_yield, 0, 0, 0);
            /* serializing instruction before executing the modified code */
            unsigned a = 0, b, c = 0, d;
            __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d) :: "memory");
            unsigned value = ((unsigned (*)(void))smc_code)();
            if(value != round * 3 + 1) __asm__ volatile("lock addl $1,%0" : "+m"(smc_bad) :: "memory", "cc");
            smc_ack = round;
        }
    }
    __asm__ volatile("lock addl $1,%0" : "+m"(xc_done) :: "memory", "cc");
}
static word read_file(const char *path, char *buffer, word size)
{
    word fd = check(S(SYS_open, path, 0, 0), path);
    word n = check(S(SYS_read, fd, buffer, size - 1), path);
    S(SYS_close, fd, 0, 0);
    buffer[n] = 0;
    return n;
}
static unsigned parse(const char *s) { unsigned n = 0; while(*s >= '0' && *s <= '9') n = n * 10 + (unsigned)(*s++ - '0'); return n; }
static void matrix(void)
{
    /* topology: one package, a distinct core per CPU, no sibling threads */
    char path[64], text[64];
    unsigned cores_seen = 0;
    for(unsigned cpu = 0; cpu < cpus; cpu++)
    {
        const char *parts[3] = {"physical_package_id", "core_id", "thread_siblings_list"};
        unsigned values[3];
        for(int k = 0; k < 3; k++)
        {
            const char *prefix = "/sys/devices/system/cpu/cpu";
            int n = 0;
            for(const char *q = prefix; *q; q++) path[n++] = *q;
            char digits[8]; int d = 0; unsigned v = cpu; do { digits[d++] = '0' + v % 10; v /= 10; } while(v);
            while(d) path[n++] = digits[--d];
            for(const char *q = "/topology/"; *q; q++) path[n++] = *q;
            for(const char *q = parts[k]; *q; q++) path[n++] = *q;
            path[n] = 0;
            read_file(path, text, sizeof(text));
            values[k] = parse(text);
        }
        if(values[0] != 0) die("package id");
        if(values[2] != cpu) die("thread siblings");
        if(cores_seen >> values[1] & 1) die("core id");
        cores_seen |= 1u << values[1];
    }
    /* O_DIRECT from the IDE disk (the probe tarball: ustar magic) */
    static char direct[8192] __attribute__((aligned(4096)));
    word disk = check(S(SYS_open, "/dev/sda", 040000, 0), "open O_DIRECT");
    if(check(S(SYS_read, disk, direct, 4096), "direct read") != 4096) die("direct read length");
    S(SYS_close, disk, 0, 0);
    if(!(direct[257] == 'u' && direct[258] == 's' && direct[259] == 't' && direct[260] == 'a' && direct[261] == 'r')) die("direct read contents");

    /* mov eax, imm32; mov ecx, 100; 1: dec ecx; jnz 1b; ret (hot enough for a JIT) */
    smc_code = (unsigned char *)mapping(4096, 7);
    if((unsigned long)smc_code >= (unsigned long)-4096) die("mmap exec");
    static const unsigned char body[] = {0xB8, 0, 0, 0, 0, 0xB9, 100, 0, 0, 0, 0xFF, 0xC9, 0x75, 0xFC, 0xC3};
    memcpy(smc_code, body, sizeof(body));
    struct { void *handler; unsigned long flags; void *restorer; unsigned long mask[2]; } action =
        {(void *)rt_signal, 0x04000004, (void *)signal_return, {0, 0}};
    /* a real-time signal: repeated sends queue instead of coalescing */
    check(sc(SYS_rt_sigaction, 40, (word)&action, 0, 8, 0, 0), "sigaction rt");
    set_cpu(0);
    for(unsigned id = 0; id < cpus; id++)
        check(spawn(xc_worker, id, xc_stacks[id] + sizeof(xc_stacks[id]), 0x00050F00), "clone xc");
    while(xc_ready != cpus) S(SYS_sched_yield, 0, 0, 0);
    word tgid = S(SYS_getpid, 0, 0, 0);
    for(unsigned n = 0; n < SIGNALS; n++)
        for(unsigned id = 0; id < cpus; id++)
            check(sc(SYS_tgkill, tgid, tids[id], 40, 0, 0, 0), "tgkill");
    for(unsigned round = 1; round <= SMC_ROUNDS; round++)
    {
        unsigned value = round * 3 + 1;
        memcpy(smc_code + 1, &value, 4);
        __asm__ volatile("" ::: "memory");
        smc_sequence = round;
        while(smc_ack != round) S(SYS_sched_yield, 0, 0, 0);
    }
    while(xc_done != cpus) S(SYS_sched_yield, 0, 0, 0);
    unsigned migrated = 0, signals = 0;
    for(unsigned id = 0; id < cpus; id++) { migrated += moved[id]; signals += signalled[id]; }
    if(migrated != cpus * MIGRATIONS) die("migration count");
    if(signals != cpus * SIGNALS) die("signal count");
    if(smc_bad) die("cross-modified code");
    out("X64_PROBE_XC arch=" ARCH " packages=1 cores="); number(cpus); out(" threads_per_core=1 migrations="); number(migrated);
    out(" signals="); number(signals); out(" smc_rounds="); number(SMC_ROUNDS); out(" direct_io=1\n");
}

/* The auxiliary vector follows argv and envp on the initial stack. */
static word auxv(word *stack, word type)
{
    word *p = stack + 1 + stack[0] + 1;
    while(*p) p++;
    for(p++; p[0]; p += 2) if(p[0] == type) return p[1];
    return 0;
}

void entry(word *stack)
{
    out("X64_PROBE_START arch=" ARCH "\n");
    const char *entry_path = "syscall";
#if !defined(__x86_64__)
    /* Compatibility processes normally enter through the vDSO's
     * __kernel_vsyscall (SYSENTER on Intel), then return via SYSRETL/IRET. */
    word vsyscall = auxv(stack, 32 /* AT_SYSINFO */);
    if(!vsyscall) die("AT_SYSINFO");
    word via_vdso, via_int80 = S(SYS_getpid, 0, 0, 0);
    __asm__ volatile("call *%1" : "=a"(via_vdso) : "r"(vsyscall), "a"(SYS_getpid) : "memory", "cc", "ecx", "edx");
    if(via_vdso != via_int80) die("vDSO getpid");
    entry_path = "vdso";
#else
    if(!auxv(stack, 33 /* AT_SYSINFO_EHDR */)) die("AT_SYSINFO_EHDR");
#endif
    struct { char sysname[65], nodename[65], release[65], version[65], machine[65], domain[65]; } names;
    check(S(SYS_uname, &names, 0, 0), "uname");
    if(!same(names.machine, "x86_64")) die("uname machine");
    if(sizeof(void *) * 8 != (ARCH[0] == '6' ? 64 : 32)) die("pointer width");

    unsigned long affinity[16] = {0};
    word bytes = check(S(SYS_sched_getaffinity, 0, sizeof(affinity), affinity), "getaffinity");
    for(word i = 0; i < bytes / (word)sizeof(affinity[0]); i++)
        for(unsigned long m = affinity[i]; m; m &= m - 1) cpus++;
    if(cpus == 0 || cpus > THREADS) die("cpu count");

    /* mmap, then write to a read-only page: the handler sees the exact page
     * address, restores write access, and the faulting store is retried. */
    word *pages = mapping(8192, 3);
    if((unsigned long)pages >= (unsigned long)-4096) die("mmap");
    for(int i = 0; i < 4096 / (int)sizeof(word); i++) pages[i] = (word)i * 0x01010101;
    protected_page = (word *)((char *)pages + 4096);
    struct { void *handler; unsigned long flags; void *restorer; unsigned long mask[2]; } action =
        {(void *)segv, 0x04000004, (void *)signal_return, {0, 0}};
    check(sc(SYS_rt_sigaction, 11, (word)&action, 0, 8, 0, 0), "sigaction");
    check(S(SYS_mprotect, protected_page, 4096, 1), "mprotect");
    protected_page[3] = 0x5A5A;
    if(fault_address != (word)protected_page + 3 * (word)sizeof(word) || protected_page[3] != 0x5A5A) die("SIGSEGV round trip");
    if(pages[5] != 5 * 0x01010101) die("mapping contents");

    int fds[2];
    check(S(SYS_pipe, fds, 0, 0), "pipe");
    word child = check(S(SYS_fork, 0, 0, 0), "fork");
    if(child == 0)
    {
        word pid = S(SYS_getpid, 0, 0, 0);
        S(SYS_write, fds[1], &pid, sizeof(pid));
        S(SYS_exit, 7, 0, 0);
    }
    word reported = 0;
    if(check(S(SYS_read, fds[0], &reported, sizeof(reported)), "pipe read") != sizeof(reported) || reported != child) die("pipe pid");
    int status = 0;
    if(check(sc(SYS_wait4, child, (word)&status, 0, 0, 0, 0), "wait4") != child || status != 7 << 8) die("child status");

    watched = mapping(4096, 3);
    if((unsigned long)watched >= (unsigned long)-4096) die("mmap watched");
    *watched = 1;
    /* CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM */
    for(unsigned id = 0; id < cpus; id++)
        check(spawn(worker, id, stacks[id] + sizeof(stacks[id]), 0x00050F00), "clone");
    while(readers != cpus) S(SYS_sched_yield, 0, 0, 0);
    if(remap((word)watched) != (word)watched) die("mmap fixed");
    *watched = 2;
    remapped = 1;
    while(finished != cpus) S(SYS_sched_yield, 0, 0, 0);
    if(stale) die("stale TLB entry after remap");
    if(counter != cpus * ITERATIONS) die("locked counter");
    for(unsigned id = 0; id < cpus; id++) if(bound[id] != id + 1) die("thread binding");

    static char data[4096], back[4096];
    for(int i = 0; i < 4096; i++) data[i] = (char)(i * 7 + 3);
    word fd = check(S(SYS_open, "/tmp/x64-probe", 0102, 0644), "open");
    if(check(S(SYS_write, fd, data, sizeof(data)), "file write") != sizeof(data)) die("short write");
    check(S(SYS_lseek, fd, 0, 0), "lseek");
    if(check(S(SYS_read, fd, back, sizeof(back)), "file read") != sizeof(back)) die("short read");
    for(int i = 0; i < 4096; i++) if(back[i] != data[i]) die("file contents");
    S(SYS_close, fd, 0, 0);
    check(S(SYS_unlink, "/tmp/x64-probe", 0, 0), "unlink");

    /* Physical placement: count touched pages whose frame is at or above
     * 4 GiB (PFN 0x100000), with contents verified through the mapping. */
    static unsigned long long frames[4096];
    unsigned char *block = (unsigned char *)mapping(16 << 20, 3);
    if((unsigned long)block >= (unsigned long)-4096) die("mmap block");
    for(int i = 0; i < 4096; i++) block[i * 4096 + (i & 4095)] = (unsigned char)(i * 13 + 1);
    word map = check(S(SYS_open, "/proc/self/pagemap", 0, 0), "open pagemap");
#if defined(__x86_64__)
    check(S(SYS_lseek, map, (unsigned long)block / 4096 * 8, 0), "pagemap seek");
#else
    /* _llseek: the 32-bit offset of a user page index always fits */
    long long position = 0;
    check(sc(140, map, 0, (word)((unsigned long)block / 4096 * 8), (word)&position, 0, 0), "pagemap seek");
#endif
    for(word done = 0, n; done < (word)sizeof(frames); done += n)
        if((n = check(S(SYS_read, map, (char *)frames + done, sizeof(frames) - done), "pagemap read")) == 0) die("pagemap eof");
    S(SYS_close, map, 0, 0);
    unsigned high_pages = 0;
    for(int i = 0; i < 4096; i++)
    {
        if(!(frames[i] >> 63)) die("page not present");
        if((frames[i] & ((1ull << 55) - 1)) >= 0x100000) high_pages++;
        if(block[i * 4096 + (i & 4095)] != (unsigned char)(i * 13 + 1)) die("block contents");
    }

    out("X64_PROBE_OK arch=" ARCH " cpus="); number(cpus);
    out(" threads="); number(cpus); out(" counter="); number(counter);
    out(" cpu_checks="); for(unsigned id = 0; id < cpus; id++) { if(id) out(","); number(bound[id] - 1); }
    out(" fault=page child=7 tlb_stale="); number(stale); out(" entry="); out(entry_path); out(" high_pages="); number(high_pages); out("\n");
    matrix();
    S(SYS_exit_group, 0, 0, 0);
    for(;;);
}
