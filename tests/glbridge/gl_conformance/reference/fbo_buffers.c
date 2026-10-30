#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name) {
    GLint values[4]; glGetIntegerv(GL_DRAW_BUFFER0, values); glGetIntegerv(GL_DRAW_BUFFER1, values+1);
    glGetIntegerv(GL_DRAW_BUFFER2, values+2); glGetIntegerv(GL_READ_BUFFER, values+3);
    printf("%s\n    \"%s\":[%d,%d,%d,%d]", first ? "" : ",", name, values[0], values[1], values[2], values[3]); first = 0;
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    GLuint fbo[2]; glGenFramebuffersEXT(2, fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo[0]); query("initial_a");
    GLenum draw[] = {GL_COLOR_ATTACHMENT2_EXT, GL_NONE, GL_COLOR_ATTACHMENT1_EXT};
    glDrawBuffers(3, draw); glReadBuffer(GL_COLOR_ATTACHMENT2_EXT); query("configured_a");
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo[1]); query("initial_b");
    glDrawBuffer(GL_NONE); glReadBuffer(GL_NONE); query("configured_b");
    glBindFramebufferEXT(0x8CA9 /* DRAW_FRAMEBUFFER_EXT */, fbo[0]); query("draw_a_read_b");
    glPushAttrib(GL_COLOR_BUFFER_BIT | GL_PIXEL_MODE_BIT);
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo[1]); glDrawBuffer(GL_COLOR_ATTACHMENT3_EXT); glReadBuffer(GL_COLOR_ATTACHMENT3_EXT);
    glPopAttrib(); query("pop_on_b");
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo[0]); query("return_to_a");
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo[1]); query("return_to_b");
    GLenum duplicate[] = {GL_COLOR_ATTACHMENT0_EXT, GL_COLOR_ATTACHMENT0_EXT}; glDrawBuffers(2, duplicate);
    printf("\n  },\n  \"duplicate_error\":%u", glGetError());
    glDrawBuffer(GL_BACK); printf(",\n  \"fbo_back_error\":%u", glGetError());
    glReadBuffer(0xFFFFFFFFu); printf(",\n  \"bad_enum_error\":%u\n}\n", glGetError());
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
