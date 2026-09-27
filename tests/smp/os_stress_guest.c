/* Freestanding i386 Linux C3 workload. Build with os_stress.mjs.
 * MAP_SHARED publication is deliberately ordinary x86 loads/stores; only the
 * shared progress increment is LOCKed. Nothing edits the emulator's CPU state. */
typedef unsigned int u32;
typedef unsigned char u8;
static int sc(int n, int a, int b, int c, int d, int e)
{
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c), "S"(d), "D"(e) : "memory", "cc");
    return r;
}
#define S(n,a,b,c) sc(n,(int)(a),(int)(b),(int)(c),0,0)
static int length(const char *s) { int n = 0; while(s[n]) n++; return n; }
static void out(const char *s) { S(4,1,s,length(s)); }
static void number(u32 n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); out(b + i); }
static void die(const char *s) { out("C3_FAIL "); out(s); out("\n"); S(1,1,0,0); for(;;); }
static int check(int n, const char *s) { if(n < 0) die(s); return n; }
static void yield(void) { S(158,0,0,0); }
struct slot { volatile u32 sequence, ack, payload, inverse; };
struct shared { struct slot slots[8]; volatile u32 progress[8], cpu_checks[8], signals, fail; };
static struct shared *shared;
static u32 cores, seed, rounds;
static int parent_pid;
static void signal_handler(int n) { (void)n; __asm__ volatile("lock incl %0" : "+m"(shared->signals) :: "memory", "cc"); }
__asm__(".text\n.global signal_return\nsignal_return:\nmov $173,%eax\nint $0x80\nud2\n");
extern void signal_return(void);
static void bind_cpu(u32 id)
{
    u32 mask = 1u << id, actual = 0xFFFFFFFF;
    check(S(241,0,4,&mask), "affinity");
    check(S(318,&actual,0,0), "getcpu");
    if(actual != id) die("migration");
    __asm__ volatile("lock incl %0" : "+m"(shared->cpu_checks[id]) :: "memory", "cc");
}
static u32 value(u32 iteration, u32 id) { return (seed * 1664525u + iteration * 1013904223u) ^ (id * 0x9E3779B9u); }
static void child(u32 id)
{
    for(u32 i = 1; i <= rounds; i++)
    {
        bind_cpu((id + i / 8) % cores);
        struct slot *s = &shared->slots[id];
        while(s->sequence != i) yield();
        if(s->payload != value(i,id) || s->inverse != ~s->payload) die("publication");
        __asm__ volatile("lock incl %0" : "+m"(shared->progress[id]) :: "memory", "cc");
        s->ack = i;
        if((i & 7) == 0) check(S(37,parent_pid,10,0), "kill");
    }
    S(1,0,0,0);
    for(;;);
}
static int socket_call(int op, int *args) { return S(102,op,args,0); }
struct sockaddr_ll { unsigned short family, protocol; int ifindex; unsigned short hatype; u8 pkttype, halen, addr[8]; };
static int net_open(struct sockaddr_ll *address)
{
    int args[6] = {17,3,0xB588,0,0,0};
    int fd = check(socket_call(1,args), "socket");
    int socket_type = 0, type_length = 4;
    args[0] = fd; args[1] = 1; args[2] = 3; args[3] = (int)&socket_type; args[4] = (int)&type_length;
    check(socket_call(15,args), "socket type");
    if(socket_type != 3) { out("C3_SOCKET_TYPE "); number(socket_type); out("\n"); die("socket type mismatch"); }
    char request[40] = {'e','t','h','0',0};
    check(S(54,fd,0x8933,request), "ifindex");
    address->family = 17; address->protocol = 0xB588;
    address->ifindex = *(int *)(request + 16); address->halen = 6;
    for(u32 i = 0; i < 6; i++) address->addr[i] = 255;
    args[0] = fd; args[1] = (int)address; args[2] = sizeof(*address);
    check(socket_call(2,args), "bind packet socket");
    int timeout[2] = {5,0};
    args[0] = fd; args[1] = 1; args[2] = 20; args[3] = (int)timeout; args[4] = sizeof(timeout);
    check(socket_call(14,args), "socket timeout");
    return fd;
}
static void net_round(int fd, struct sockaddr_ll *address, u32 iteration)
{
    u8 frame[64] = {0}, received[128];
    for(int i = 0; i < 6; i++) frame[i] = 255;
    frame[6] = 2; frame[11] = 1; frame[12] = 0x88; frame[13] = 0xB5;
    for(u32 i = 14; i < sizeof(frame); i++) frame[i] = (u8)(value(iteration,i) >> (i & 7));
    /* EtherType payload declares its length; link-layer padding is ignored. */
    frame[14] = sizeof(frame) - 14; frame[15] = frame[16] = frame[17] = 0;
    int args[6] = {fd,(int)frame,sizeof(frame),0,(int)address,sizeof(*address)};
    if(check(socket_call(11,args), "send packet") != sizeof(frame)) die("short network send");
    for(;;)
    {
        args[0] = fd; args[1] = (int)received; args[2] = sizeof(received); args[3] = args[4] = args[5] = 0;
        int n = socket_call(12,args);
        if(n == -4) continue;
        if(check(n,"receive packet") < (int)sizeof(frame)) die("short network payload");
        for(u32 i = 14; i < sizeof(frame); i++) if(frame[i] != received[i]) die("network payload");
        break;
    }
}
static u8 disk_write[4096] __attribute__((aligned(4096)));
static u8 disk_read[4096] __attribute__((aligned(4096)));
static void disk_round(int fd, u32 iteration)
{
    int offset = (1 << 20) + (seed & 31) * 8192;
    for(u32 i = 0; i < sizeof(disk_write); i++) disk_write[i] = (u8)(value(iteration,i) >> (i & 7));
    check(S(19,fd,offset,0),"disk seek write");
    if(check(S(4,fd,disk_write,sizeof(disk_write)),"disk write") != sizeof(disk_write)) die("disk short write");
    check(S(118,fd,0,0),"disk fsync");
    check(S(19,fd,offset,0),"disk seek read");
    if(check(S(3,fd,disk_read,sizeof(disk_read)),"disk read") != sizeof(disk_read)) die("disk short read");
    for(u32 i = 0; i < sizeof(disk_write); i++) if(disk_read[i] != disk_write[i]) die("disk payload");
}
static u32 parse(char *s) { u32 n = 0; while(*s >= '0' && *s <= '9') n = n * 10 + *s++ - '0'; return n; }
void entry(int *stack)
{
    if(stack[0] != 4) die("usage: cores seed rounds");
    char **argv = (char **)(stack + 1);
    cores = parse(argv[1]); seed = parse(argv[2]); rounds = parse(argv[3]);
    if(cores < 2 || cores > 8 || rounds < 16 || rounds > 4096) die("arguments");
    u32 mapping[6] = {0,4096,3,0x21,0xFFFFFFFF,0};
    shared = (struct shared *)S(90,mapping,0,0);
    if((u32)shared >= 0xFFFFF001u) die("mmap shared");
    /* mmap may return a valid address with its high bit set. */
    parent_pid = check(S(20,0,0,0),"getpid");
    struct { void (*handler)(int); u32 flags; void (*restorer)(void); u32 mask[2]; } action = {signal_handler,0x04000004,signal_return,{0,0}};
    check(sc(174,10,(int)&action,0,8,0), "sigaction");
    int disk = S(5,"/dev/sda",2 | 0x4000,0);
    if(disk < 0) disk = S(5,"/dev/hda",2 | 0x4000,0);
    check(disk,"open emulated disk");
    struct sockaddr_ll address = {0};
    int net = net_open(&address);
    for(u32 id = 1; id < cores; id++) if(check(S(2,0,0,0),"fork") == 0) child(id);
    out("C3_ACTIVE seed="); number(seed); out("\n");
    for(u32 i = 1; i <= rounds; i++)
    {
        bind_cpu((i / 8) % cores);
        for(u32 id = 1; id < cores; id++)
        {
            struct slot *s = &shared->slots[id];
            s->payload = value(i,id); s->inverse = ~s->payload;
            __asm__ volatile("" ::: "memory");
            s->sequence = i;
        }
        for(u32 id = 1; id < cores; id++) while(shared->slots[id].ack != i) yield();
        shared->progress[0]++;
        if((i & 7) == 0) { disk_round(disk,i); net_round(net,&address,i); }
    }
    for(u32 id = 1; id < cores; id++) { int status, result; do { result = S(7,-1,&status,0); } while(result == -4); check(result,"waitpid"); if(status) die("child exit"); }
    if(!shared->signals) die("no signal delivery");
    for(u32 id = 0; id < cores; id++) if(shared->progress[id] != rounds || shared->cpu_checks[id] != rounds) die("core progress");
    out("C3_DONE seed="); number(seed); out(" rounds="); number(rounds); out(" cores="); number(cores);
    out(" signals="); number(shared->signals); out(" io="); number(rounds / 8); out(" cpu_checks=");
    for(u32 id = 0; id < cores; id++) { if(id) out(","); number(shared->cpu_checks[id]); }
    out("\n");
    S(1,0,0,0);
    for(;;);
}
__asm__(".text\n.global _start\n_start:\nmov %esp,%eax\npush %eax\ncall entry\nud2\n");
