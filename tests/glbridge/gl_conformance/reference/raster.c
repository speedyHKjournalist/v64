/* Independent current-raster-state reference. A complete target is needed:
 * macOS's non-drawable default framebuffer rejects RasterPos with 0x506.
 * Build like state.c, using the legacy OpenGL framework.
 */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void vector(const char* name, const GLfloat* v, int count) {
    printf("\"%s\":[", name);
    for (int i = 0; i < count; ++i) printf("%s%.17g", i ? "," : "", (double)v[i]);
    printf("]");
}
static void query(const char* name) {
    GLfloat p[4], c[4], secondary[4], t[4], d; GLboolean valid;
    glGetFloatv(GL_CURRENT_RASTER_POSITION, p); glGetFloatv(GL_CURRENT_RASTER_COLOR, c);
    glGetFloatv(GL_CURRENT_RASTER_SECONDARY_COLOR, secondary); glGetFloatv(GL_CURRENT_RASTER_TEXTURE_COORDS, t);
    glGetFloatv(GL_CURRENT_RASTER_DISTANCE, &d); glGetBooleanv(GL_CURRENT_RASTER_POSITION_VALID, &valid);
    GLenum error = glGetError(); if (error) { fprintf(stderr, "%s GL error %x\n", name, error); return; }
    printf("%s\n    \"%s\":{", first ? "" : ",", name); first = 0;
    vector("position", p, 4); printf(","); vector("color", c, 4); printf(","); vector("secondary", secondary, 4);
    printf(","); vector("texture", t, 4); printf(",\"distance\":[%.17g],\"valid\":[%d]}", (double)d, valid);
}
int main(void) {
    CGLPixelFormatAttribute attrs[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint count;
    if (CGLChoosePixelFormat(attrs, &pf, &count) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    GLuint tex, fbo; glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 128, 128, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffersEXT(1, &fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, tex, 0); glDrawBuffer(GL_COLOR_ATTACHMENT0_EXT);
    glViewport(10, 20, 100, 60);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    query("default");
    glColor4f(.25, .5, .75, 1); glTexCoord4f(.1, .2, .3, 1);
    glMatrixMode(GL_TEXTURE); glTranslatef(2, 3, 4); glMatrixMode(GL_MODELVIEW); glTranslatef(.2, .3, .4);
    glRasterPos4f(.2, .2, .2, 2); query("raster_w2");
    glFogCoordf(3.5); glDepthRange(.25, .75); glWindowPos3f(-5, 900, .3); query("window_unlit");
    glLoadIdentity(); glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glRasterPos3f(0, 0, 0); query("lit_raster");
    glWindowPos3f(0, 0, 0); query("lit_window");
    GLfloat specular[] = {.5, .5, .5, 1}; glMaterialfv(GL_FRONT, GL_SPECULAR, specular); glMaterialf(GL_FRONT, GL_SHININESS, 16);
    glLightModeli(GL_LIGHT_MODEL_COLOR_CONTROL, GL_SEPARATE_SPECULAR_COLOR); glRasterPos3f(0, 0, 0); query("lit_specular");
    glScalef(2, 4, 8); glNormal3f(.577350269f, .577350269f, .577350269f); glRasterPos3f(0, 0, 0); query("normal_raw");
    glEnable(GL_NORMALIZE); glRasterPos3f(0, 0, 0); query("normal_unit");
    glDisable(GL_NORMALIZE); glEnable(GL_RESCALE_NORMAL); glRasterPos3f(0, 0, 0); query("normal_rescale");
    glDisable(GL_LIGHTING); glDisable(GL_RESCALE_NORMAL); glLoadIdentity();
    GLfloat plane[] = {.5, 0, 0, 1}; glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_S, GL_OBJECT_PLANE, plane); glEnable(GL_TEXTURE_GEN_S);
    glRasterPos3f(.2, 0, 0); query("texgen");
    glRasterPos3f(3, 0, 0); query("clipped");
    glFogi(GL_FOG_COORD_SRC, GL_FOG_COORD); glWindowPos3f(5, 6, .5); query("window_fog");
    glBitmap(0, 0, 0, 0, 5, -7, NULL); query("bitmap");
    glActiveTexture(GL_TEXTURE3); glMultiTexCoord4f(GL_TEXTURE3, 2, 3, 4, 5); glMatrixMode(GL_TEXTURE); glTranslatef(7, 8, 9);
    glMatrixMode(GL_MODELVIEW); glRasterPos3f(0, 0, 0); query("unit3");
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
