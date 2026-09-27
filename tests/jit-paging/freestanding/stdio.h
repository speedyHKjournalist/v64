// Minimal Linux i386 libc for test-jit*.c on hosts without a Linux toolchain; see libc.c.
#pragma once
#include <stdarg.h>
typedef struct { int fd; } FILE;
extern FILE *stdout, *stderr;
int printf(const char *format, ...);
int fprintf(FILE *stream, const char *format, ...);
int vfprintf(FILE *stream, const char *format, va_list args);
int fflush(FILE *stream);
