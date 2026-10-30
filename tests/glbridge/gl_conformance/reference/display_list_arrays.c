#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
typedef struct { GLfloat xyz[3];GLubyte color[4]; } Vertex;
static int first=1;
static void report(const char* name) {
    GLubyte pixel[4];glReadPixels(4,3,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
    printf("%s{\"name\":\"%s\",\"pixel\":[%u,%u,%u,%u],\"error\":%u}",first?"":",\n",name,pixel[0],pixel[1],pixel[2],pixel[3],glGetError());first=0;
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color,vbo,ebo;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,8,8);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);glViewport(0,0,8,8);
    glGenBuffers(1,&vbo);glGenBuffers(1,&ebo);glBindBuffer(GL_ARRAY_BUFFER,vbo);
    Vertex vertices[1001];memset(vertices,0,sizeof(vertices));
    vertices[1]=(Vertex){{-1,-1,0},{0,255,0,255}};vertices[2]=(Vertex){{1,-1,0},{0,255,0,255}};vertices[3]=(Vertex){{0,1,0},{0,255,0,255}};
    glBufferData(GL_ARRAY_BUFFER,sizeof(vertices),vertices,GL_STATIC_DRAW);glVertexPointer(3,GL_FLOAT,sizeof(Vertex),(void*)0);glColorPointer(4,GL_UNSIGNED_BYTE,sizeof(Vertex),(void*)12);glEnableClientState(GL_VERTEX_ARRAY);glEnableClientState(GL_COLOR_ARRAY);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glNewList(100,GL_COMPILE);glDrawArrays(GL_TRIANGLES,1,3);glEndList();
    memset(vertices,0,sizeof(vertices));glBufferData(GL_ARRAY_BUFFER,sizeof(vertices),vertices,GL_STATIC_DRAW);glDisableClientState(GL_VERTEX_ARRAY);glDisableClientState(GL_COLOR_ARRAY);glCallList(100);report("arrays_frozen");
    vertices[0]=(Vertex){{-1,-1,0},{0,0,255,255}};vertices[5]=(Vertex){{1,-1,0},{0,0,255,255}};vertices[1000]=(Vertex){{0,1,0},{0,0,255,255}};
    glBufferData(GL_ARRAY_BUFFER,sizeof(vertices),vertices,GL_STATIC_DRAW);glEnableClientState(GL_VERTEX_ARRAY);glEnableClientState(GL_COLOR_ARRAY);
    GLuint indices[]={1000,0,5};glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,ebo);glBufferData(GL_ELEMENT_ARRAY_BUFFER,sizeof(indices),indices,GL_STATIC_DRAW);
    glNewList(101,GL_COMPILE);glDrawElements(GL_TRIANGLES,3,GL_UNSIGNED_INT,0);glEndList();
    glNewList(102,GL_COMPILE);glDrawRangeElements(GL_TRIANGLES,0,1000,3,GL_UNSIGNED_INT,0);glEndList();
    memset(indices,0,sizeof(indices));glBufferData(GL_ELEMENT_ARRAY_BUFFER,sizeof(indices),indices,GL_STATIC_DRAW);glDeleteBuffers(1,&vbo);glDeleteBuffers(1,&ebo);
    glClear(GL_COLOR_BUFFER_BIT);glCallList(101);report("elements_frozen");glClear(GL_COLOR_BUFFER_BIT);glCallList(102);report("range_frozen");
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
