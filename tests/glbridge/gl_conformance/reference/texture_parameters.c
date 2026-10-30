#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, GLenum pname, int count) {
    GLfloat f[4] = {0}; GLint i[4] = {0};
    glGetTexParameterfv(GL_TEXTURE_2D, pname, f); glGetTexParameteriv(GL_TEXTURE_2D, pname, i);
    printf("%s\n    \"%s\":{\"float\":[", first ? "" : ",", name); first = 0;
    for (int n=0; n<count; ++n) printf("%s%.17g", n ? "," : "", f[n]);
    printf("],\"int\":["); for (int n=0; n<count; ++n) printf("%s%d", n ? "," : "", i[n]);
    printf("],\"error\":%u}", glGetError());
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    query("default_min", GL_TEXTURE_MIN_FILTER, 1); query("default_priority", GL_TEXTURE_PRIORITY, 1);
    query("default_border", GL_TEXTURE_BORDER_COLOR, 4); query("default_compare", GL_TEXTURE_COMPARE_FUNC, 1);
    GLfloat border[] = {-2, .5, 2, 1}; glTexParameterfv(GL_TEXTURE_2D, GL_TEXTURE_BORDER_COLOR, border); query("float_border", GL_TEXTURE_BORDER_COLOR, 4);
    GLint iborder[] = {-2147483647-1, 0, 1073741824, 2147483647}; glTexParameteriv(GL_TEXTURE_2D, GL_TEXTURE_BORDER_COLOR, iborder); query("int_border", GL_TEXTURE_BORDER_COLOR, 4);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_PRIORITY, 1); query("int_priority", GL_TEXTURE_PRIORITY, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_PRIORITY, .75); query("float_priority", GL_TEXTURE_PRIORITY, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_BASE_LEVEL, 2.75); query("float_base", GL_TEXTURE_BASE_LEVEL, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_GENERATE_MIPMAP, .25); query("float_boolean", GL_GENERATE_MIPMAP, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_GENERATE_MIPMAP, .75); query("float_boolean_high", GL_GENERATE_MIPMAP, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_LOD, -2.75); query("min_lod", GL_TEXTURE_MIN_LOD, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_LOD_BIAS, 100); query("lod_bias", GL_TEXTURE_LOD_BIAS, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY_EXT, 2.5); query("anisotropy", GL_TEXTURE_MAX_ANISOTROPY_EXT, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, (GLfloat)GL_LINEAR + .25f); query("float_enum", GL_TEXTURE_MIN_FILTER, 1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, (GLfloat)GL_LINEAR + .75f); query("float_enum_high", GL_TEXTURE_MIN_FILTER, 1);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
