#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#ifndef GL_ANY_SAMPLES_PASSED
#define GL_ANY_SAMPLES_PASSED 0x8C2F
#endif
static int first=1;
static void integer(const char* name, GLint value) { printf("%s\n    \"%s\":%d",first?"":",",name,value); first=0; }
static void error(const char* name) { integer(name,glGetError()); }
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx, shared; GLint n; GLuint generated;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx)||CGLCreateContext(pf,ctx,&shared))return 2;
    CGLSetCurrentContext(ctx); glGenQueries(1,&generated);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    integer("reserved",glIsQuery(generated)); glBeginQuery(GL_SAMPLES_PASSED,7); error("unused_begin"); integer("created",glIsQuery(7));
    glGetQueryiv(GL_SAMPLES_PASSED,GL_CURRENT_QUERY,&n); integer("current",n);
    glBeginQuery(GL_SAMPLES_PASSED,0); error("zero_begin"); glBeginQuery(GL_SAMPLES_PASSED,8); error("nested_begin");
    glGenQueries(0,NULL); error("active_gen_zero"); GLuint unused=999; glDeleteQueries(1,&unused); error("active_delete_unused");
    glGetQueryObjectiv(7,GL_QUERY_RESULT_AVAILABLE,&n); error("active_result");
    glEndQuery(GL_SAMPLES_PASSED); error("valid_end"); glEndQuery(GL_SAMPLES_PASSED); error("missing_end");
    glGetQueryObjectiv(7,0,&n); error("bad_pname"); glGetQueryObjectiv(9,GL_QUERY_RESULT,&n); error("missing_result");
    glGetQueryObjectiv(generated,GL_QUERY_RESULT,&n); error("reserved_result");
    glBeginQuery(GL_ANY_SAMPLES_PASSED,7); error("changed_target");
    glGetQueryiv(GL_ANY_SAMPLES_PASSED,GL_CURRENT_QUERY,&n); if(n)glEndQuery(GL_ANY_SAMPLES_PASSED);
    glEndQuery(GL_TEXTURE_2D); error("bad_target");
    glBeginQuery(GL_SAMPLES_PASSED,7); CGLSetCurrentContext(shared); integer("shared_is_query",glIsQuery(7));
    glBeginQuery(GL_SAMPLES_PASSED,7); error("parallel_begin"); glEndQuery(GL_SAMPLES_PASSED);
    CGLSetCurrentContext(ctx); glGetQueryiv(GL_SAMPLES_PASSED,GL_CURRENT_QUERY,&n); integer("first_current",n); glEndQuery(GL_SAMPLES_PASSED);
    glFinish(); glGetQueryObjectiv(7,GL_QUERY_RESULT,&n); integer("empty_result",n);
    glDeleteQueries(1,&unused); error("delete_unused"); unused=7; glDeleteQueries(1,&unused); integer("deleted",glIsQuery(7));
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(shared); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
