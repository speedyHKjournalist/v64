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
    CGLPixelFormatAttribute attrs[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0 };
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
    printf("\n  }\n}\n");
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf);
    return 0;
}
