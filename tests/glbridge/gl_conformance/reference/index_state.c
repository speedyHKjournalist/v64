#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void query(const char* name,GLenum pname){
    GLdouble d=0;GLfloat f=0;GLint i=0;GLboolean b=0;glGetDoublev(pname,&d);glGetFloatv(pname,&f);glGetIntegerv(pname,&i);glGetBooleanv(pname,&b);
    printf("%s{\"name\":\"%s\",\"pname\":%u,\"error\":%u,\"values\":[%.17g,%.17g,%d,%u]}",first?"":",\n",name,pname,glGetError(),d,(double)f,i,b);first=0;
}
static void error(const char* name){printf("%s{\"name\":\"%s\",\"error\":%u}",first?"":",\n",name,glGetError());first=0;}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    query("current_default",GL_CURRENT_INDEX);query("clear_default",GL_INDEX_CLEAR_VALUE);query("mask_default",GL_INDEX_WRITEMASK);
    glIndexd(16777217.25);query("double_precision",GL_CURRENT_INDEX);glIndexf(-3.5f);query("negative_half",GL_CURRENT_INDEX);glIndexf(-0.5f);query("negative_small_half",GL_CURRENT_INDEX);
    glIndexub(255);query("byte_value",GL_CURRENT_INDEX);glClearIndex(-3.5f);query("clear_value",GL_INDEX_CLEAR_VALUE);glIndexMask(0x80000001u);query("mask_value",GL_INDEX_WRITEMASK);
    glPushAttrib(GL_CURRENT_BIT|GL_COLOR_BUFFER_BIT);glIndexf(7.25f);glClearIndex(8.5f);glIndexMask(7);glPopAttrib();query("current_restored",GL_CURRENT_INDEX);query("clear_restored",GL_INDEX_CLEAR_VALUE);query("mask_restored",GL_INDEX_WRITEMASK);
    glNewList(1,GL_COMPILE);glIndexf(9.5f);glEndList();query("list_compile",GL_CURRENT_INDEX);glCallList(1);query("list_call",GL_CURRENT_INDEX);
    glBegin(GL_POINTS);glIndexf(2.75f);glEnd();query("index_inside_begin",GL_CURRENT_INDEX);glBegin(GL_POINTS);glClearIndex(10);glEnd();error("clear_inside_begin");
    glBegin(GL_POINTS);glIndexMask(0);glEnd();error("mask_inside_begin");printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
