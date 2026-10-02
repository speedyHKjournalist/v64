/* The little of <stddef.h> that third_party/vulkan's headers need, for
 * tests/x64/vktest.c (x86_64 Linux, musl; the host has no musl headers) */
#ifndef V86_STDDEF_H
#define V86_STDDEF_H
typedef unsigned long size_t;
typedef long ptrdiff_t;
#define NULL ((void *)0)
#define offsetof(type, member) __builtin_offsetof(type, member)
#endif
