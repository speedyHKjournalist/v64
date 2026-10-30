#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj first,second; GLint n,binding,removed,shared; GLfloat old[4],fresh[4];
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&first)||CGLCreateContext(pf,first,&second))return 2;
    const char* vertex="!!ARBvp1.0\nMOV result.position,vertex.position;\nEND";
    const char* fragment="!!ARBfp1.0\nMOV result.color,fragment.color;\nEND";
    CGLSetCurrentContext(first); glBindProgramARB(GL_VERTEX_PROGRAM_ARB,7);
    glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(vertex),vertex);
    glProgramLocalParameter4fARB(GL_VERTEX_PROGRAM_ARB,3,1,2,3,4);
    CGLSetCurrentContext(second); glBindProgramARB(GL_VERTEX_PROGRAM_ARB,7);
    CGLSetCurrentContext(first); GLuint name=7; glDeleteProgramsARB(1,&name);
    glGetProgramivARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_BINDING_ARB,&removed);
    glBindProgramARB(GL_FRAGMENT_PROGRAM_ARB,7);
    glProgramStringARB(GL_FRAGMENT_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(fragment),fragment);
    glProgramLocalParameter4fARB(GL_FRAGMENT_PROGRAM_ARB,3,9,8,7,6);
    glGetProgramLocalParameterfvARB(GL_FRAGMENT_PROGRAM_ARB,3,fresh);
    CGLSetCurrentContext(second); glGetProgramivARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_BINDING_ARB,&binding);
    glGetProgramLocalParameterfvARB(GL_VERTEX_PROGRAM_ARB,3,old); shared=glIsProgramARB(7);
    if(glGetError())return 3; glBindProgramARB(GL_VERTEX_PROGRAM_ARB,7); GLenum error=glGetError();
    printf("{\"renderer\":\"%s\",\"removedBinding\":%d,\"retainedBinding\":%d,\"reusedNameExists\":%d,\"retainedLocal\":[%g,%g,%g,%g],\"reusedLocal\":[%g,%g,%g,%g],\"wrongTargetError\":%u}\n",
        glGetString(GL_RENDERER),removed,binding,shared,old[0],old[1],old[2],old[3],fresh[0],fresh[1],fresh[2],fresh[3],error);
    CGLSetCurrentContext(NULL); CGLDestroyContext(second); CGLDestroyContext(first); CGLDestroyPixelFormat(pf); return 0;
}
