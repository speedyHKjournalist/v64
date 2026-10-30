#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static int first=1;
static void print(const char* name,const GLubyte* bytes,int size,GLenum error,GLenum setter,int pbo) {
    printf("%s{\"name\":\"%s\",\"error\":%u,\"setterError\":%u,\"pboSize\":%d,\"bytes\":[",first?"":",\n",name,error,setter,pbo);first=0;
    for(int i=0;i<size;i++)printf("%s%u",i?",":"",bytes[i]);printf("]}");
}
static void read_pattern(const char* name,int size,GLenum setter) {
    GLubyte bytes[512];memset(bytes,0xA5,sizeof(bytes));glGetPolygonStipple(bytes);print(name,bytes,size,glGetError(),setter,0);
}
static void pack(int alignment,int length,int rows,int pixels,int lsb) {
    glPixelStorei(GL_PACK_ALIGNMENT,alignment);glPixelStorei(GL_PACK_ROW_LENGTH,length);glPixelStorei(GL_PACK_SKIP_ROWS,rows);glPixelStorei(GL_PACK_SKIP_PIXELS,pixels);glPixelStorei(GL_PACK_LSB_FIRST,lsb);
}
static void upload_pbo(const char* name,int size,int mapped,const GLubyte* pattern) {
    GLuint buffer;glGenBuffers(1,&buffer);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,buffer);glBufferData(GL_PIXEL_UNPACK_BUFFER,size,pattern,GL_STATIC_DRAW);
    if(mapped)glMapBuffer(GL_PIXEL_UNPACK_BUFFER,GL_READ_ONLY);glPolygonStipple(NULL);GLenum error=glGetError();
    if(mapped)glUnmapBuffer(GL_PIXEL_UNPACK_BUFFER);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);glDeleteBuffers(1,&buffer);read_pattern(name,128,error);
}
static void read_pbo(const char* name,int size,int mapped) {
    GLuint buffer;GLubyte bytes[128];memset(bytes,0xA5,sizeof(bytes));glGenBuffers(1,&buffer);glBindBuffer(GL_PIXEL_PACK_BUFFER,buffer);glBufferData(GL_PIXEL_PACK_BUFFER,size,bytes,GL_STATIC_DRAW);
    if(mapped)glMapBuffer(GL_PIXEL_PACK_BUFFER,GL_READ_ONLY);glGetPolygonStipple(NULL);GLenum error=glGetError();
    if(mapped)glUnmapBuffer(GL_PIXEL_PACK_BUFFER);glGetBufferSubData(GL_PIXEL_PACK_BUFFER,0,size,bytes);print(name,bytes,size,error,0,size);
    glBindBuffer(GL_PIXEL_PACK_BUFFER,0);glDeleteBuffers(1,&buffer);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,8,8);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    if(glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT)!=GL_FRAMEBUFFER_COMPLETE_EXT)return 3;
    GLubyte source[512],pbo[128],ones[128];for(int i=0;i<512;i++)source[i]=(i*73)^0xA6;for(int i=0;i<128;i++)pbo[i]=i*17;memset(ones,255,sizeof(ones));
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));read_pattern("default",128,0);
    glPixelStorei(GL_UNPACK_ALIGNMENT,8);glPixelStorei(GL_UNPACK_ROW_LENGTH,40);glPixelStorei(GL_UNPACK_SKIP_ROWS,1);glPixelStorei(GL_UNPACK_SKIP_PIXELS,5);glPixelStorei(GL_UNPACK_LSB_FIRST,1);
    glPolygonStipple(source);GLenum error=glGetError();glPixelStorei(GL_UNPACK_ALIGNMENT,4);glPixelStorei(GL_UNPACK_ROW_LENGTH,0);glPixelStorei(GL_UNPACK_SKIP_ROWS,0);glPixelStorei(GL_UNPACK_SKIP_PIXELS,0);glPixelStorei(GL_UNPACK_LSB_FIRST,0);
    read_pattern("unpack_rows",128,error);pack(8,40,1,3,1);read_pattern("pack_rows",320,0);pack(1,0,0,0,1);read_pattern("pack_lsb",128,0);
    pack(1,1,0,3,0);read_pattern("pack_overlap",64,0);pack(4,0,0,0,0);
    glPushAttrib(GL_POLYGON_STIPPLE_BIT);glPolygonStipple(ones);glPopAttrib();read_pattern("attrib_restore",128,glGetError());
    upload_pbo("upload_pbo",128,0,pbo);upload_pbo("upload_short_pbo",127,0,ones);upload_pbo("upload_mapped_pbo",128,1,ones);
    read_pbo("read_pbo",128,0);read_pbo("read_short_pbo",127,0);read_pbo("read_mapped_pbo",128,1);
    glBegin(GL_TRIANGLES);glPolygonStipple(ones);glEnd();error=glGetError();read_pattern("upload_begin",128,error);
    GLubyte bytes[128];memset(bytes,0xA5,sizeof(bytes));glBegin(GL_TRIANGLES);glGetPolygonStipple(bytes);glEnd();print("read_begin",bytes,128,glGetError(),0,0);
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
