#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, GLenum error) {
    GLint v[9] = {0}; GLenum p[] = {GL_RENDERBUFFER_WIDTH_EXT, GL_RENDERBUFFER_HEIGHT_EXT, GL_RENDERBUFFER_INTERNAL_FORMAT_EXT,
        GL_RENDERBUFFER_RED_SIZE_EXT, GL_RENDERBUFFER_GREEN_SIZE_EXT, GL_RENDERBUFFER_BLUE_SIZE_EXT,
        GL_RENDERBUFFER_ALPHA_SIZE_EXT, GL_RENDERBUFFER_DEPTH_SIZE_EXT, GL_RENDERBUFFER_STENCIL_SIZE_EXT};
    for (int i = 0; i < 9; ++i) glGetRenderbufferParameterivEXT(GL_RENDERBUFFER_EXT, p[i], v+i);
    printf("%s\n    \"%s\":{\"error\":%u,\"values\":[", first ? "" : ",", name, error); first = 0;
    for (int i = 0; i < 9; ++i) printf("%s%d", i ? "," : "", v[i]); printf("]}");
    glGetError();
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx); glBindRenderbufferEXT(GL_RENDERBUFFER_EXT, 1);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    query("initial", glGetError());
    GLenum f[] = {GL_RGBA8, GL_RGB8, GL_RGBA4, GL_DEPTH_COMPONENT16, GL_DEPTH_COMPONENT24,
        GL_STENCIL_INDEX1_EXT, GL_STENCIL_INDEX4_EXT, GL_STENCIL_INDEX8_EXT, GL_STENCIL_INDEX16_EXT, GL_RGBA16F_ARB};
    const char* names[] = {"rgba8", "rgb8", "rgba4", "depth16", "depth24", "stencil1", "stencil4", "stencil8", "stencil16", "rgba16f"};
    for (int i = 0; i < 10; ++i) { glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT, f[i], 7, 5); query(names[i], glGetError()); }
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT, GL_RGBA8, 0, 5); query("zero_width", glGetError());
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
