#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static int first=1;
static void report(const char* name,const GLubyte* bytes,int count) {
    GLint alignment,rowLength,skipRows,skipPixels,lsb;glGetIntegerv(GL_UNPACK_ALIGNMENT,&alignment);glGetIntegerv(GL_UNPACK_ROW_LENGTH,&rowLength);glGetIntegerv(GL_UNPACK_SKIP_ROWS,&skipRows);glGetIntegerv(GL_UNPACK_SKIP_PIXELS,&skipPixels);glGetIntegerv(GL_UNPACK_LSB_FIRST,&lsb);
    GLint imageHeight,skipImages,swap;glGetIntegerv(GL_UNPACK_IMAGE_HEIGHT,&imageHeight);glGetIntegerv(GL_UNPACK_SKIP_IMAGES,&skipImages);glGetIntegerv(GL_UNPACK_SWAP_BYTES,&swap);
    printf("%s{\"name\":\"%s\",\"unpack\":[%d,%d,%d,%d,%d,%d,%d,%d],\"error\":%u,\"bytes\":[",first?"":",\n",name,alignment,rowLength,skipRows,skipPixels,lsb,imageHeight,skipImages,swap,glGetError());first=0;
    for(int i=0;i<count;i++)printf("%s%u",i?",":"",bytes[i]);printf("]}");
}
static void unpack(int alignment,int length,int rows,int pixels,int lsb) {
    glPixelStorei(GL_UNPACK_ALIGNMENT,alignment);glPixelStorei(GL_UNPACK_ROW_LENGTH,length);glPixelStorei(GL_UNPACK_SKIP_ROWS,rows);glPixelStorei(GL_UNPACK_SKIP_PIXELS,pixels);glPixelStorei(GL_UNPACK_LSB_FIRST,lsb);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);glViewport(0,0,16,16);
    glPixelStorei(GL_PACK_ALIGNMENT,1);printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    GLubyte source[512],out[512];memset(source,0,sizeof(source));source[4]=0xA8;source[5]=0x0A;source[8]=0x50;source[9]=0x05;
    unpack(4,16,1,3,1);glNewList(10,GL_COMPILE);glBitmap(9,2,0,0,3,2,source);glEndList();memset(source,0,sizeof(source));unpack(1,32,0,0,0);
    glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glColor4f(1,0,0,1);glWindowPos2i(0,0);glCallList(10);glReadPixels(0,0,9,2,GL_RGBA,GL_UNSIGNED_BYTE,out);report("bitmap",out,72);
    memset(source,0,sizeof(source));GLubyte rgb[]={255,0,0,0,255,0,0,0,255,255,255,255};memcpy(source+19,rgb,6);memcpy(source+35,rgb+6,6);
    unpack(8,3,1,1,0);glNewList(20,GL_COMPILE);glDrawPixels(2,2,GL_RGB,GL_UNSIGNED_BYTE,source);glEndList();memset(source,0,sizeof(source));unpack(1,0,0,0,1);
    glWindowPos2i(0,0);glCallList(20);glReadPixels(0,0,2,2,GL_RGBA,GL_UNSIGNED_BYTE,out);report("draw_pixels",out,16);
    GLubyte rgba[]={32,64,96,128,160,192,224,255,10,20,30,40,200,150,100,50};memset(source,0,sizeof(source));memcpy(source+20,rgba,8);memcpy(source+36,rgba+8,8);
    glBindTexture(GL_TEXTURE_2D,1);unpack(8,3,1,1,0);glNewList(30,GL_COMPILE);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,source);glEndList();memset(source,0,sizeof(source));unpack(1,0,0,0,1);
    glBindTexture(GL_TEXTURE_2D,2);glCallList(30);glGetTexImage(GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,out);report("texture",out,16);
    for(int i=0;i<512;i++)source[i]=(i*73)^0xA6;unpack(8,40,1,5,1);glNewList(40,GL_COMPILE);glPolygonStipple(source);glEndList();memset(source,0,sizeof(source));unpack(1,0,0,0,0);glCallList(40);glGetPolygonStipple(out);report("stipple",out,128);
    GLuint pbo;for(int i=0;i<128;i++)source[i]=i*17;glGenBuffers(1,&pbo);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,pbo);glBufferData(GL_PIXEL_UNPACK_BUFFER,128,source,GL_STATIC_DRAW);
    glNewList(50,GL_COMPILE);glPolygonStipple(NULL);glGetPolygonStipple(out);report("pbo_compiling",out,128);glEndList();glDeleteBuffers(1,&pbo);glCallList(50);glGetPolygonStipple(out);report("pbo_called",out,128);
    memset(source,0,sizeof(source));memcpy(source+19,rgb,6);unpack(8,3,1,1,0);glNewList(31,GL_COMPILE);glTexSubImage2D(GL_TEXTURE_2D,0,0,0,2,1,GL_RGB,GL_UNSIGNED_BYTE,source);glEndList();memset(source,0,sizeof(source));unpack(1,0,0,0,0);
    glCallList(31);glGetTexImage(GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,out);report("sub_texture",out,16);
    GLubyte swapped[]={0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0};unpack(1,0,0,0,0);glPixelStorei(GL_UNPACK_SWAP_BYTES,1);glBindTexture(GL_TEXTURE_2D,4);
    glNewList(60,GL_COMPILE);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_SHORT,swapped);glEndList();glPixelStorei(GL_UNPACK_SWAP_BYTES,0);memset(swapped,0,sizeof(swapped));glCallList(60);glGetTexImage(GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,out);report("swap_texture",out,4);
    memset(source,0,sizeof(source));for(int z=0;z<2;z++)for(int y=0;y<2;y++)for(int x=0;x<6;x++)source[67+z*48+y*16+x]=(z*12+y*6+x)*7;
    unpack(8,3,1,1,0);glPixelStorei(GL_UNPACK_IMAGE_HEIGHT,3);glPixelStorei(GL_UNPACK_SKIP_IMAGES,1);glBindTexture(GL_TEXTURE_3D,3);
    glNewList(70,GL_COMPILE);glTexImage3D(GL_TEXTURE_3D,0,GL_RGB8,2,2,2,0,GL_RGB,GL_UNSIGNED_BYTE,source);glEndList();memset(source,0,sizeof(source));unpack(1,0,0,0,0);glPixelStorei(GL_UNPACK_IMAGE_HEIGHT,0);glPixelStorei(GL_UNPACK_SKIP_IMAGES,0);
    glCallList(70);glGetTexImage(GL_TEXTURE_3D,0,GL_RGBA,GL_UNSIGNED_BYTE,out);report("texture_3d",out,32);
    for(int mapped=0;mapped<2;mapped++) {
        GLuint p;glGenBuffers(1,&p);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,p);glBufferData(GL_PIXEL_UNPACK_BUFFER,mapped?128:127,source,GL_STATIC_DRAW);if(mapped)glMapBuffer(GL_PIXEL_UNPACK_BUFFER,GL_READ_ONLY);
        glNewList(80+mapped,GL_COMPILE);glPolygonStipple(NULL);glGetPolygonStipple(out);report(mapped?"mapped_compiling":"short_compiling",out,128);glEndList();
        if(mapped)glUnmapBuffer(GL_PIXEL_UNPACK_BUFFER);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);glCallList(80+mapped);glGetPolygonStipple(out);report(mapped?"mapped_called":"short_called",out,128);glDeleteBuffers(1,&p);
    }
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
