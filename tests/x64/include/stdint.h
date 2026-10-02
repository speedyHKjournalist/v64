/* The little of <stdint.h> that third_party/vulkan's headers need, for
 * tests/x64/vktest.c (x86_64 Linux, LP64) */
#ifndef V86_STDINT_H
#define V86_STDINT_H
typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef short int16_t;
typedef unsigned short uint16_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef long int64_t;
typedef unsigned long uint64_t;
typedef long intptr_t;
typedef unsigned long uintptr_t;
#define UINT32_MAX 0xFFFFFFFFu
#define UINT64_MAX 0xFFFFFFFFFFFFFFFFul
#endif
