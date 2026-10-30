/* Independent GL 2.1 parameter-query oracle; build like state.c. */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, int family, GLenum target, GLenum pname, int n) {
    GLint iv[4] = {0}; GLfloat fv[4] = {0}; GLdouble dv[4] = {0};
    if (family == 1) { glGetLightiv(target, pname, iv); glGetLightfv(target, pname, fv); }
    if (family == 2) { glGetMaterialiv(target, pname, iv); glGetMaterialfv(target, pname, fv); }
    if (family == 3) { glGetTexEnviv(target, pname, iv); glGetTexEnvfv(target, pname, fv); }
    if (family == 4) { glGetTexGeniv(target, pname, iv); glGetTexGenfv(target, pname, fv); glGetTexGendv(target, pname, dv); }
    if (family == 5) glGetClipPlane(target, dv);
    GLenum error = glGetError();
    if (error) { fprintf(stderr, "%s: GL error %x\n", name, error); return; }
    printf("%s\n    \"%s\": {\"integer\":[", first ? "" : ",", name); first = 0;
    for (int i = 0; i < n; ++i) printf("%s%d", i ? "," : "", iv[i]);
    printf("],\"float\":[");
    for (int i = 0; i < n; ++i) printf("%s%.17g", i ? "," : "", (double)fv[i]);
    printf("],\"double\":[");
    for (int i = 0; i < n; ++i) printf("%s%.17g", i ? "," : "", dv[i]);
    printf("]}");
}
int main(void) {
    CGLPixelFormatAttribute attrs[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0 };
    CGLPixelFormatObj pf = NULL; CGLContextObj ctx = NULL; GLint count;
    if (CGLChoosePixelFormat(attrs, &pf, &count) || !pf || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    query("material_default", 2, GL_FRONT, GL_AMBIENT, 4);
    glTranslatef(2, 3, 4); glScalef(2, 4, 8);
    GLfloat position[] = {1, 2, 3, 1}, direction[] = {2, 3, -1};
    glLightfv(GL_LIGHT2, GL_POSITION, position); glLightfv(GL_LIGHT2, GL_SPOT_DIRECTION, direction);
    GLdouble equation[] = {1, 2, 4, 8}; glClipPlane(GL_CLIP_PLANE2, equation);
    GLfloat eye[] = {1, 2, 4, 8}; glTexGenfv(GL_S, GL_EYE_PLANE, eye);
    glLoadIdentity();
    query("position", 1, GL_LIGHT2, GL_POSITION, 4); query("direction", 1, GL_LIGHT2, GL_SPOT_DIRECTION, 3);
    query("clip", 5, GL_CLIP_PLANE2, 0, 4); query("eye", 4, GL_S, GL_EYE_PLANE, 4);
    GLfloat color[] = {.5f, .25f, 0, 1}; glLightfv(GL_LIGHT2, GL_DIFFUSE, color); query("light_color", 1, GL_LIGHT2, GL_DIFFUSE, 4);
    GLint icolor[] = {2147483647, 0, 1073741824, 2147483647};
    glMaterialiv(GL_FRONT_AND_BACK, GL_DIFFUSE, icolor); query("material_int", 2, GL_BACK, GL_DIFFUSE, 4);
    glLightf(GL_LIGHT2, GL_SPOT_EXPONENT, 12.75f); query("exponent", 1, GL_LIGHT2, GL_SPOT_EXPONENT, 1);
    glActiveTexture(GL_TEXTURE3); glTexEnvfv(GL_TEXTURE_ENV, GL_TEXTURE_ENV_COLOR, color); query("env_color", 3, GL_TEXTURE_ENV, GL_TEXTURE_ENV_COLOR, 4);
    glTexEnviv(GL_TEXTURE_ENV, GL_TEXTURE_ENV_COLOR, icolor); query("env_int", 3, GL_TEXTURE_ENV, GL_TEXTURE_ENV_COLOR, 4);
    glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_RGB, GL_INTERPOLATE); query("combine", 3, GL_TEXTURE_ENV, GL_COMBINE_RGB, 1);
    glTexEnvf(GL_TEXTURE_FILTER_CONTROL, GL_TEXTURE_LOD_BIAS, 2.75f); query("bias", 3, GL_TEXTURE_FILTER_CONTROL, GL_TEXTURE_LOD_BIAS, 1);
    glTexEnvi(GL_POINT_SPRITE, GL_COORD_REPLACE, GL_TRUE); query("replace", 3, GL_POINT_SPRITE, GL_COORD_REPLACE, 1);
    glTexGeni(GL_T, GL_TEXTURE_GEN_MODE, GL_SPHERE_MAP); query("gen_mode", 4, GL_T, GL_TEXTURE_GEN_MODE, 1);
    glActiveTexture(GL_TEXTURE0); query("env_unit0", 3, GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, 1);
    glColor4f(.25f, .5f, .75f, 1); glColorMaterial(GL_BACK, GL_EMISSION); glEnable(GL_COLOR_MATERIAL);
    query("tracked", 2, GL_BACK, GL_EMISSION, 4);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
