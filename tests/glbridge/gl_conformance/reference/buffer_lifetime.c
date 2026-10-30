#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void arrays(void) {
    glVertexPointer(3,GL_FLOAT,0,(void*)4);glColorPointer(4,GL_UNSIGNED_BYTE,0,(void*)0);
    glClientActiveTexture(GL_TEXTURE3);glTexCoordPointer(2,GL_FLOAT,0,(void*)0);glVertexAttribPointer(2,4,GL_FLOAT,0,0,(void*)0);
}
static void bind_all(GLuint name) {
    glBindBuffer(GL_ARRAY_BUFFER,name);glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,name);glBindBuffer(GL_PIXEL_PACK_BUFFER,name);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,name);
}
static void print(const char* name) {
    GLenum p[]={GL_ARRAY_BUFFER_BINDING,GL_ELEMENT_ARRAY_BUFFER_BINDING,GL_PIXEL_PACK_BUFFER_BINDING,GL_PIXEL_UNPACK_BUFFER_BINDING,
        GL_VERTEX_ARRAY_BUFFER_BINDING,GL_COLOR_ARRAY_BUFFER_BINDING,GL_TEXTURE_COORD_ARRAY_BUFFER_BINDING};
    GLint v[8]={0},size=0,mapped=0;GLint data[4]={0};GLvoid* pointer=NULL;
    for(int i=0;i<7;i++)glGetIntegerv(p[i],&v[i]);glGetVertexAttribiv(2,GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,&v[7]);glGetPointerv(GL_VERTEX_ARRAY_POINTER,&pointer);
    if(v[0]){glGetBufferParameteriv(GL_ARRAY_BUFFER,GL_BUFFER_SIZE,&size);glGetBufferParameteriv(GL_ARRAY_BUFFER,GL_BUFFER_MAPPED,&mapped);if(!mapped)glGetBufferSubData(GL_ARRAY_BUFFER,0,size<16?size:16,data);}
    printf("%s{\"name\":\"%s\",\"isBuffer\":%u,\"bindings\":[",first?"":",\n",name,glIsBuffer(7));first=0;
    for(int i=0;i<8;i++)printf("%s%d",i?",":"",v[i]);
    printf("],\"pointer\":%lu,\"size\":%d,\"mapped\":%d,\"data\":[%d,%d,%d,%d],\"error\":%u}",
        (unsigned long)pointer,size,mapped,data[0],data[1],data[2],data[3],glGetError());
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj first,second;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&first)||CGLCreateContext(pf,first,&second))return 2;
    CGLSetCurrentContext(first);GLint data[]={11,22,33,44};GLuint name=7;bind_all(name);glBufferData(GL_ARRAY_BUFFER,sizeof(data),data,GL_STATIC_DRAW);arrays();
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));print("first_before");glPushClientAttrib(GL_CLIENT_VERTEX_ARRAY_BIT|GL_CLIENT_PIXEL_STORE_BIT);
    CGLSetCurrentContext(second);bind_all(name);arrays();print("second_before");
    CGLSetCurrentContext(first);glDeleteBuffers(1,&name);print("first_deleted");glPopClientAttrib();print("first_popped");
    CGLSetCurrentContext(second);print("second_retained");
    CGLSetCurrentContext(first);bind_all(name);GLint replacement[]={55,66,77,88};glBufferData(GL_ARRAY_BUFFER,sizeof(replacement),replacement,GL_STATIC_DRAW);print("first_reused");
    CGLSetCurrentContext(second);print("second_after_reuse");glDeleteBuffers(1,&name);print("second_deleted_public");
    CGLSetCurrentContext(first);print("first_retained_new");
    CGLSetCurrentContext(second);glBindBuffer(GL_ARRAY_BUFFER,8);glBufferData(GL_ARRAY_BUFFER,sizeof(data),data,GL_STATIC_DRAW);glMapBuffer(GL_ARRAY_BUFFER,GL_READ_WRITE);
    CGLSetCurrentContext(first);glBindBuffer(GL_ARRAY_BUFFER,8);GLuint mapped=8;glDeleteBuffers(1,&mapped);
    CGLSetCurrentContext(second);print("second_mapped_deleted");
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(second);CGLDestroyContext(first);CGLDestroyPixelFormat(pf);return 0;
}
