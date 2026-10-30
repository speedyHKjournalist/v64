/* Independent ARB parameter-binding counts from a legacy desktop GL.
 * clang -Wno-deprecated-declarations arb.c -framework OpenGL -o /tmp/gl-arb-oracle
 */
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static const char* names[] = {"none", "high", "unused", "matrix", "duplicate", "relative_constants"};
static const char* sources[] = {
    "!!ARBvp1.0\nMOV result.position, vertex.position;\nEND",
    "!!ARBvp1.0\nADD result.position, program.env[95], program.local[94];\nEND",
    "!!ARBvp1.0\nPARAM unused = { 1 };\nMOV result.position, vertex.position;\nEND",
    "!!ARBvp1.0\nPARAM mvp[4] = { state.matrix.mvp };\nDP4 result.position.x,mvp[0],vertex.position;\nDP4 result.position.y,mvp[1],vertex.position;\nDP4 result.position.z,mvp[2],vertex.position;\nDP4 result.position.w,mvp[3],vertex.position;\nEND",
    "!!ARBvp1.0\nPARAM c = {1,2,3,4};\nPARAM d = {1,2,3,4};\nADD result.position,c,d;\nEND",
    "!!ARBvp1.0\nPARAM arr[2] = {{1,1,1,1},{1,1,1,1}};\nADDRESS a;\nARL a.x,vertex.position.x;\nMOV result.position,arr[a.x];\nEND",
};
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint count;
    if (CGLChoosePixelFormat(a, &pf, &count) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    for (unsigned int i = 0; i < sizeof(sources) / sizeof(sources[0]); ++i) {
        GLuint p; GLint value; glGenProgramsARB(1, &p); glBindProgramARB(GL_VERTEX_PROGRAM_ARB, p);
        glProgramStringARB(GL_VERTEX_PROGRAM_ARB, GL_PROGRAM_FORMAT_ASCII_ARB, (GLsizei)strlen(sources[i]), sources[i]);
        if (glGetError()) { fprintf(stderr, "ARB load failed: %s\n", names[i]); return 3; }
        glGetProgramivARB(GL_VERTEX_PROGRAM_ARB, GL_PROGRAM_PARAMETERS_ARB, &value);
        if (glGetError()) return 4;
        printf("%s\n    \"%s\":%d", i ? "," : "", names[i], value); glDeleteProgramsARB(1, &p);
    }
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
