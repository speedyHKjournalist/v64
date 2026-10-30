/* GL 2.1 section 2.15.2: failed relinks retain the installed executable. */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void value(const char* name, int v) {
    printf("%s\n    \"%s\":%d", first ? "" : ",", name, v); first = 0;
}
static void pixel(const char* name) {
    GLubyte rgba[4] = {0}; glClearColor(1, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
    glBegin(GL_QUADS); glVertex2f(-1, -1); glVertex2f(1, -1); glVertex2f(1, 1); glVertex2f(-1, 1); glEnd();
    glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
    printf(",\n    \"%s\":[%u,%u,%u,%u]", name, rgba[0], rgba[1], rgba[2], rgba[3]);
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    GLuint tex, fb; glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffersEXT(1, &fb); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fb);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, tex, 0);
    glViewport(0, 0, 1, 1);
    const char* vs = "void main() { gl_Position = gl_Vertex; }";
    const char* fs = "uniform vec4 tint; void main() { gl_FragColor = tint; }";
    const char* bad = "void main() { gl_FragColor = unknownValue; }";
    GLuint v = glCreateShader(GL_VERTEX_SHADER), f = glCreateShader(GL_FRAGMENT_SHADER), p = glCreateProgram();
    glShaderSource(v, 1, &vs, NULL); glCompileShader(v); glShaderSource(f, 1, &fs, NULL); glCompileShader(f);
    glAttachShader(p, v); glAttachShader(p, f); glLinkProgram(p); glUseProgram(p);
    GLint at = glGetUniformLocation(p, "tint"), status; glUniform4f(at, .25, .5, .75, 1);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    glShaderSource(f, 1, &bad, NULL); glGetShaderiv(f, GL_COMPILE_STATUS, &status); value("source_only_compile_status", status);
    glLinkProgram(p); glGetProgramiv(p, GL_LINK_STATUS, &status); value("source_only_link_status", status);
    glUniform4f(glGetUniformLocation(p, "tint"), .25, .5, .75, 1);
    at = glGetUniformLocation(p, "tint");
    glCompileShader(f); glLinkProgram(p); glGetProgramiv(p, GL_LINK_STATUS, &status); value("failed_link_status", status);
    value("failed_link_error", glGetError()); pixel("after_failure"); value("draw_error", glGetError());
    glUniform4f(at, .5, .25, .75, 1); value("uniform_after_failure_error", glGetError()); pixel("after_uniform");
    GLfloat guarded[4] = {-7, -7, -7, -7}; glGetUniformfv(p, at, guarded);
    value("query_after_failure_error", glGetError()); value("query_preserves_output", guarded[0] == -7);
    glUseProgram(p); value("use_failed_error", glGetError()); pixel("after_rejected_use");
    glShaderSource(f, 1, &fs, NULL); glCompileShader(f); glLinkProgram(p);
    glGetProgramiv(p, GL_LINK_STATUS, &status); value("repaired_link_status", status); pixel("after_success");
    value("final_error", glGetError()); printf("\n  }\n}\n");
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
