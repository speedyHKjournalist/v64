/* Typed glGet reference for plan C3. macOS, like reference/ref.c:
 * clang -Wno-deprecated-declarations state.c -framework OpenGL -o /tmp/gl-state-oracle
 * /tmp/gl-state-oracle > ../state_reference.json
 * Query results come from a fresh legacy context, independently of VGL2.
 */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>

static int first = 1;
static void query(const char* name, GLenum pname, int n) {
    GLint integers[16]; GLfloat floats[16]; GLdouble doubles[16]; GLboolean booleans[16];
    glGetIntegerv(pname, integers); glGetFloatv(pname, floats);
    glGetDoublev(pname, doubles); glGetBooleanv(pname, booleans);
    if (glGetError()) { fprintf(stderr, "query failed: %s\n", name); return; }
    printf("%s\n    \"%s\": {\"integer\":[", first ? "" : ",", name); first = 0;
    for (int i = 0; i < n; ++i) printf("%s%d", i ? "," : "", integers[i]);
    printf("],\"float\":[");
    for (int i = 0; i < n; ++i) printf("%s%.17g", i ? "," : "", (double)floats[i]);
    printf("],\"double\":[");
    for (int i = 0; i < n; ++i) printf("%s%.17g", i ? "," : "", doubles[i]);
    printf("],\"boolean\":[");
    for (int i = 0; i < n; ++i) printf("%s%d", i ? "," : "", booleans[i]);
    printf("]}");
}
int main(void) {
    CGLPixelFormatAttribute attrs[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,
        kCGLPFAStencilSize, (CGLPixelFormatAttribute)8, 0 };
    CGLPixelFormatObj pf = NULL; CGLContextObj ctx = NULL; GLint count = 0;
    if (CGLChoosePixelFormat(attrs, &pf, &count) || !pf || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    glClearColor(.5f, 0, 1, .25f); query("color", GL_COLOR_CLEAR_VALUE, 4);
    glClearAccum(-1, -.5f, 0, .5f); query("accum", GL_ACCUM_CLEAR_VALUE, 4);
    glDepthRange(.25, .75); query("depth", GL_DEPTH_RANGE, 2);
    glLineWidth(2.75f); query("width", GL_LINE_WIDTH, 1);
    glViewport(-20, 5, 120, 45); query("viewport", GL_VIEWPORT, 4);
    glMatrixMode(GL_MODELVIEW); glTranslatef(2, 3, 4); glScalef(2, 4, 8); query("modelview", GL_MODELVIEW_MATRIX, 16);
    glMatrixMode(GL_TEXTURE); glActiveTexture(GL_TEXTURE3); glTranslatef(7, 8, 9); query("texture3", GL_TEXTURE_MATRIX, 16);
    glActiveTexture(GL_TEXTURE0); query("texture0", GL_TEXTURE_MATRIX, 16);
    glPushClientAttrib(GL_CLIENT_PIXEL_STORE_BIT); glPixelStorei(GL_UNPACK_ROW_LENGTH, 31); glPopClientAttrib(); query("unpack", GL_UNPACK_ROW_LENGTH, 1);
    query("mask_all", GL_STENCIL_VALUE_MASK, 1);
    glStencilFuncSeparate(GL_FRONT, GL_LESS, -7, 0x80000001u); query("ref_front", GL_STENCIL_REF, 1); query("mask_high", GL_STENCIL_VALUE_MASK, 1);
    glStencilFuncSeparate(GL_BACK, GL_GEQUAL, 1000, ~0u); query("ref_back", GL_STENCIL_BACK_REF, 1);
    GLuint fbo; glGenFramebuffersEXT(1, &fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo); query("ref_empty", GL_STENCIL_BACK_REF, 1);
    glStencilFuncSeparate(GL_BACK, GL_GEQUAL, 42, ~0u); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, 0); query("ref_returned", GL_STENCIL_BACK_REF, 1);
    glDeleteFramebuffersEXT(1, &fbo);
    query("dither", GL_DITHER, 1);
    glActiveTexture(GL_TEXTURE3); glEnable(GL_TEXTURE_2D); query("texture3_enabled", GL_TEXTURE_2D, 1);
    glClientActiveTexture(GL_TEXTURE0); glEnableClientState(GL_TEXTURE_COORD_ARRAY); query("client0_enabled", GL_TEXTURE_COORD_ARRAY, 1);
    glClientActiveTexture(GL_TEXTURE3); query("client3_disabled", GL_TEXTURE_COORD_ARRAY, 1);
    glHint(GL_FOG_HINT, GL_NICEST); query("hint", GL_FOG_HINT, 1);
    GLfloat fog_color[] = {.5f, -.25f, 2.f, .25f}; glFogfv(GL_FOG_COLOR, fog_color); query("fog_color", GL_FOG_COLOR, 4);
    glFogf(GL_FOG_DENSITY, 2.75f); query("fog_density", GL_FOG_DENSITY, 1);
    GLfloat attenuation[] = {1, 2, 3}; glPointParameterfv(GL_POINT_DISTANCE_ATTENUATION, attenuation); query("point_attenuation", GL_POINT_DISTANCE_ATTENUATION, 3);
    glPointParameterf(GL_POINT_SIZE_MIN, 2.75f); query("point_min", GL_POINT_SIZE_MIN, 1);
    glPointParameteri(GL_POINT_SPRITE_COORD_ORIGIN, GL_LOWER_LEFT); query("point_origin", GL_POINT_SPRITE_COORD_ORIGIN, 1);
    glPixelTransferf(GL_RED_SCALE, 2.75f); query("red_scale", GL_RED_SCALE, 1);
    glPixelTransferf(GL_INDEX_SHIFT, 2.75f); query("index_shift", GL_INDEX_SHIFT, 1);
    glPixelZoom(-2, .5f); query("zoom_x", GL_ZOOM_X, 1); query("zoom_y", GL_ZOOM_Y, 1);
    glLogicOp(GL_XOR); query("logic_op", GL_LOGIC_OP_MODE, 1);
    glEdgeFlag(GL_FALSE); query("edge_flag", GL_EDGE_FLAG, 1);
    printf("\n  }\n}\n");
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf);
    return 0;
}
