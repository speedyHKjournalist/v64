/* Desktop GL reference for the original float/u32/u16 PixelMap APIs. */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, GLenum map, int count) {
    GLfloat f[256]; GLuint u[256]; GLushort s[256];
    glGetPixelMapfv(map, f); glGetPixelMapuiv(map, u); glGetPixelMapusv(map, s);
    if (glGetError()) { fprintf(stderr, "query failed: %s\n", name); return; }
    printf("%s\n    \"%s\":{\"float\":[", first ? "" : ",", name); first = 0;
    for (int i = 0; i < count; ++i) printf("%s%.17g", i ? "," : "", (double)f[i]);
    printf("],\"uint\":["); for (int i = 0; i < count; ++i) printf("%s%u", i ? "," : "", u[i]);
    printf("],\"ushort\":["); for (int i = 0; i < count; ++i) printf("%s%u", i ? "," : "", s[i]); printf("]}");
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    query("default", GL_PIXEL_MAP_R_TO_R, 1);
    GLfloat f[] = {-1, .5, 1, 2}; glPixelMapfv(GL_PIXEL_MAP_R_TO_R, 4, f); query("float", GL_PIXEL_MAP_R_TO_R, 4);
    GLuint u[] = {0, 0x80000000u, 0xFFFFFFFFu, 0x40000000u}; glPixelMapuiv(GL_PIXEL_MAP_G_TO_G, 4, u); query("uint", GL_PIXEL_MAP_G_TO_G, 4);
    GLushort s[] = {0, 32768, 65535, 16384}; glPixelMapusv(GL_PIXEL_MAP_B_TO_B, 4, s); query("ushort", GL_PIXEL_MAP_B_TO_B, 4);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
