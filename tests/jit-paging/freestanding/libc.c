// Just enough of a Linux i386 libc for test-jit*.c, for hosts without a
// Linux toolchain (macOS): system calls through int 0x80, no dynamic state.
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

enum { SYS_exit_group = 252, SYS_write = 4, SYS_open = 5, SYS_getpid = 20, SYS_kill = 37,
    SYS_old_mmap = 90, SYS_munmap = 91, SYS_ftruncate = 93 };

static long syscall3(long n, long a, long b, long c)
{
    long result;
    __asm__ volatile("int $0x80" : "=a"(result) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory");
    return result;
}

static long check(long result)
{
    // Kernel errors are -4095..-1; there is no errno.
    return (unsigned long)result > -4096UL ? -1 : result;
}

void exit(int status)
{
    for(;;) syscall3(SYS_exit_group, status, 0, 0);
}

void abort(void)
{
    syscall3(SYS_kill, syscall3(SYS_getpid, 0, 0, 0), 6 /* SIGABRT */, 0);
    exit(127);
}

void *memcpy(void *dest, const void *src, size_t n)
{
    unsigned char *d = dest;
    const unsigned char *s = src;
    while(n--) *d++ = *s++;
    return dest;
}

void *memset(void *dest, int c, size_t n)
{
    unsigned char *d = dest;
    while(n--) *d++ = (unsigned char)c;
    return dest;
}

void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset)
{
    // old_mmap takes its six arguments in memory (no EBP juggling).
    unsigned long args[6] = { (unsigned long)addr, length, prot, flags, fd, offset };
    long result = syscall3(SYS_old_mmap, (long)args, 0, 0);
    return check(result) == -1 ? MAP_FAILED : (void *)result;
}

int munmap(void *addr, size_t length)
{
    return check(syscall3(SYS_munmap, (long)addr, length, 0));
}

int ftruncate(int fd, off_t length)
{
    return check(syscall3(SYS_ftruncate, fd, length, 0));
}

int mkstemp(char *template)
{
    size_t length = 0;
    while(template[length]) length++;
    if(length < 6) return -1;
    unsigned value = syscall3(SYS_getpid, 0, 0, 0);
    for(int attempt = 0; attempt < 100; attempt++, value = value * 1103515245 + 12345)
    {
        unsigned v = value;
        for(size_t i = length - 6; i < length; i++, v /= 36) template[i] = "0123456789abcdefghijklmnopqrstuvwxyz"[v % 36];
        long fd = check(syscall3(SYS_open, (long)template, 02 | 0100 | 0200 /* O_RDWR|O_CREAT|O_EXCL */, 0600));
        if(fd != -1) return fd;
    }
    return -1;
}

static FILE files[] = { { 1 }, { 2 } };
FILE *stdout = &files[0], *stderr = &files[1];

int fflush(FILE *stream)
{
    (void)stream;
    return 0;
}

// Unbuffered; supports %d, %u, %x, %s and %%.
int vfprintf(FILE *stream, const char *format, va_list args)
{
    char buffer[512];
    size_t n = 0;
    for(const char *p = format; *p && n < sizeof buffer - 16; p++)
    {
        if(*p != '%')
        {
            buffer[n++] = *p;
            continue;
        }
        char conversion = *++p;
        if(conversion == 's')
        {
            for(const char *s = va_arg(args, const char *); *s && n < sizeof buffer - 16; s++) buffer[n++] = *s;
        }
        else if(conversion == 'd' || conversion == 'u' || conversion == 'x')
        {
            unsigned base = conversion == 'x' ? 16 : 10;
            unsigned value = va_arg(args, unsigned);
            if(conversion == 'd' && (int)value < 0)
            {
                buffer[n++] = '-';
                value = -value;
            }
            char digits[12];
            int count = 0;
            do digits[count++] = "0123456789abcdef"[value % base]; while(value /= base);
            while(count) buffer[n++] = digits[--count];
        }
        else if(conversion)
        {
            buffer[n++] = conversion;
        }
        else
        {
            break;
        }
    }
    syscall3(SYS_write, stream->fd, (long)buffer, n);
    return n;
}

int fprintf(FILE *stream, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int n = vfprintf(stream, format, args);
    va_end(args);
    return n;
}

int printf(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int n = vfprintf(stdout, format, args);
    va_end(args);
    return n;
}

int main();
void __libc_start(void) { exit(main()); }
__asm__(".text\n.globl _start\n_start:\n xorl %ebp, %ebp\n andl $-16, %esp\n call __libc_start\n hlt\n");

// test-jit.c copies a whole page starting at one of its functions: keep that
// page inside the text segment, as it is in a (large) libc-linked binary.
__asm__(".text\n.fill 8192, 1, 0xCC\n");
