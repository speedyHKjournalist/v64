#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static int first=1;
static void print(const char* name,GLenum target,GLint level,GLenum format,GLenum type,int compressed,int size,GLenum error,const GLubyte* bytes,int pboSize,int pointer,int mapped) {
    printf("%s{\"name\":\"%s\",\"target\":%u,\"level\":%d,\"format\":%u,\"type\":%u,\"compressed\":%s,\"size\":%d,\"error\":%u,\"pboSize\":%d,\"pointer\":%d,\"mapped\":%s,\"bytes\":[",first?"":",\n",name,target,level,format,type,compressed?"true":"false",size,error,pboSize,pointer,mapped?"true":"false"); first=0;
    for(int i=0;i<size;i++)printf("%s%u",i?",":"",bytes[i]); printf("]}");
}
static void read_image(const char* name,GLenum target,GLint level,GLenum format,GLenum type,int size,int compressed) {
    GLubyte bytes[256]; memset(bytes,0xA5,sizeof(bytes)); while(glGetError()){}
    if(compressed)glGetCompressedTexImageARB(target,level,bytes); else glGetTexImage(target,level,format,type,bytes);
    print(name,target,level,format,type,compressed,size,glGetError(),bytes,0,0,0);
}
static void read_pbo(const char* name,int size,int pointer,int mapped,GLint level,GLenum type) {
    GLuint buffer; GLubyte bytes[256]; memset(bytes,0xA5,sizeof(bytes)); glGenBuffers(1,&buffer); glBindBuffer(GL_PIXEL_PACK_BUFFER,buffer);
    glBufferData(GL_PIXEL_PACK_BUFFER,size,bytes,GL_STREAM_READ); if(mapped)glMapBuffer(GL_PIXEL_PACK_BUFFER,GL_WRITE_ONLY);
    while(glGetError()){} glGetTexImage(GL_TEXTURE_2D,level,GL_RGBA,type,(void*)(long)pointer); GLenum error=glGetError();
    if(mapped)glUnmapBuffer(GL_PIXEL_PACK_BUFFER); glGetBufferSubData(GL_PIXEL_PACK_BUFFER,0,size,bytes);
    print(name,GL_TEXTURE_2D,level,GL_RGBA,type,0,size,error,bytes,size,pointer,mapped);
    glBindBuffer(GL_PIXEL_PACK_BUFFER,0); glDeleteBuffers(1,&buffer);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2; CGLSetCurrentContext(ctx);
    GLubyte rgba[]={32,64,96,128,160,192,224,255,10,20,30,40,200,150,100,50};
    glPixelStorei(GL_UNPACK_ALIGNMENT,1); glPixelStorei(GL_PACK_ALIGNMENT,1);
    glBindTexture(GL_TEXTURE_2D,1); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    read_image("rgba",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    read_image("rgb",GL_TEXTURE_2D,0,GL_RGB,GL_UNSIGNED_BYTE,12,0);
    read_image("bgr",GL_TEXTURE_2D,0,GL_BGR,GL_UNSIGNED_BYTE,12,0);
    read_image("luminance",GL_TEXTURE_2D,0,GL_LUMINANCE,GL_UNSIGNED_BYTE,4,0);
    read_image("luminance_alpha",GL_TEXTURE_2D,0,GL_LUMINANCE_ALPHA,GL_UNSIGNED_BYTE,8,0);
    read_image("alpha",GL_TEXTURE_2D,0,GL_ALPHA,GL_UNSIGNED_BYTE,4,0);
    read_image("red",GL_TEXTURE_2D,0,GL_RED,GL_UNSIGNED_BYTE,4,0);
    read_image("green",GL_TEXTURE_2D,0,GL_GREEN,GL_UNSIGNED_BYTE,4,0);
    read_image("blue",GL_TEXTURE_2D,0,GL_BLUE,GL_UNSIGNED_BYTE,4,0);
    read_image("rgba_float",GL_TEXTURE_2D,0,GL_RGBA,GL_FLOAT,64,0);
    read_image("rgba_ushort",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_SHORT,32,0);
    glPixelStorei(GL_PACK_SWAP_BYTES,1); read_image("swapped_ushort",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_SHORT,32,0);
    read_image("swapped_float",GL_TEXTURE_2D,0,GL_RGBA,GL_FLOAT,64,0); glPixelStorei(GL_PACK_SWAP_BYTES,0);
    read_image("packed_8888",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_INT_8_8_8_8,16,0);
    read_image("bad_depth_format",GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT,GL_FLOAT,16,0);
    read_image("bad_stencil_format",GL_TEXTURE_2D,0,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,16,0);
    read_image("bad_index_format",GL_TEXTURE_2D,0,GL_COLOR_INDEX,GL_UNSIGNED_BYTE,16,0);
    read_image("bad_bitmap",GL_TEXTURE_2D,0,GL_RGBA,GL_BITMAP,16,0);
    read_image("undefined_level",GL_TEXTURE_2D,1,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    read_image("undefined_depth",GL_TEXTURE_2D,1,GL_DEPTH_COMPONENT,GL_FLOAT,16,0);
    read_image("undefined_compressed",GL_TEXTURE_2D,1,0,0,16,1);
    read_image("negative_level",GL_TEXTURE_2D,-1,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    read_image("large_level",GL_TEXTURE_2D,99,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    glPixelTransferf(GL_RED_SCALE,2); read_image("ignores_transfer",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0); glPixelTransferf(GL_RED_SCALE,1);
    glPixelStorei(GL_PACK_ALIGNMENT,4); glPixelStorei(GL_PACK_ROW_LENGTH,4); glPixelStorei(GL_PACK_SKIP_PIXELS,1); glPixelStorei(GL_PACK_SKIP_ROWS,1);
    read_image("pack_rows",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,64,0);
    glPixelStorei(GL_PACK_ALIGNMENT,1); glPixelStorei(GL_PACK_ROW_LENGTH,0); glPixelStorei(GL_PACK_SKIP_PIXELS,0); glPixelStorei(GL_PACK_SKIP_ROWS,0);
    glPixelStorei(GL_PACK_ROW_LENGTH,1); read_image("pack_overlap",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0); glPixelStorei(GL_PACK_ROW_LENGTH,0);
    GLubyte sub[]={255,0,0,255}; glTexSubImage2D(GL_TEXTURE_2D,0,1,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,sub); read_image("subimage",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    GLfloat depth[]={0.25,0.5,0.75,1}; glBindTexture(GL_TEXTURE_2D,2); glTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT24,2,2,0,GL_DEPTH_COMPONENT,GL_FLOAT,depth);
    read_image("depth_float",GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT,GL_FLOAT,16,0);
    GLuint dfbo; glGenFramebuffersEXT(1,&dfbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,dfbo);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_TEXTURE_2D,2,0); glDrawBuffer(GL_NONE); glReadBuffer(GL_NONE);
    glClearDepth(0.625); glClear(GL_DEPTH_BUFFER_BIT); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,0);
    read_image("depth_rendered",GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT,GL_FLOAT,16,0);
    read_image("depth_as_rgba",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    glBindTexture(GL_TEXTURE_2D,6); glTexImage2D(GL_TEXTURE_2D,2,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    read_image("nonzero_level",GL_TEXTURE_2D,2,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    glBindTexture(GL_TEXTURE_CUBE_MAP,3); glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X,0,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    read_image("cube_face",GL_TEXTURE_CUBE_MAP_POSITIVE_X,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    read_image("cube_target",GL_TEXTURE_CUBE_MAP,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    GLubyte volume[24]; for(int i=0;i<24;i++)volume[i]=(GLubyte)(i*7); glBindTexture(GL_TEXTURE_3D,4); glTexImage3D(GL_TEXTURE_3D,0,GL_RGB8,2,2,2,0,GL_RGB,GL_UNSIGNED_BYTE,volume);
    glPixelStorei(GL_PACK_ALIGNMENT,4); glPixelStorei(GL_PACK_ROW_LENGTH,3); glPixelStorei(GL_PACK_IMAGE_HEIGHT,3); glPixelStorei(GL_PACK_SKIP_IMAGES,1); glPixelStorei(GL_PACK_SKIP_ROWS,1); glPixelStorei(GL_PACK_SKIP_PIXELS,1);
    read_image("pack_volume",GL_TEXTURE_3D,0,GL_RGB,GL_UNSIGNED_BYTE,128,0);
    glPixelStorei(GL_PACK_ALIGNMENT,1); glPixelStorei(GL_PACK_ROW_LENGTH,0); glPixelStorei(GL_PACK_IMAGE_HEIGHT,0); glPixelStorei(GL_PACK_SKIP_IMAGES,0); glPixelStorei(GL_PACK_SKIP_ROWS,0); glPixelStorei(GL_PACK_SKIP_PIXELS,0);
    GLubyte block[]={255,255,0,0,0,0,0,0}; glBindTexture(GL_TEXTURE_2D,5); glCompressedTexImage2DARB(GL_TEXTURE_2D,0,GL_COMPRESSED_RGB_S3TC_DXT1_EXT,4,4,0,8,block);
    read_image("compressed_raw",GL_TEXTURE_2D,0,0,0,8,1); read_image("compressed_rgba",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,64,0);
    GLubyte redblock[]={0,248,0,0,0,0,0,0}; glCompressedTexSubImage2DARB(GL_TEXTURE_2D,0,0,0,4,4,GL_COMPRESSED_RGB_S3TC_DXT1_EXT,8,redblock);
    read_image("compressed_sub_raw",GL_TEXTURE_2D,0,0,0,8,1); read_image("compressed_sub_rgba",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,64,0);
    glBindTexture(GL_TEXTURE_2D,1); read_image("uncompressed_as_compressed",GL_TEXTURE_2D,0,0,0,16,1);
    GLuint fbo; glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo); glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0);
    glViewport(0,0,2,2); glClearColor(0.25,0.5,0.75,1); glClear(GL_COLOR_BUFFER_BIT); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,0);
    read_image("rendered_unbound_fbo",GL_TEXTURE_2D,0,GL_RGBA,GL_UNSIGNED_BYTE,16,0);
    read_pbo("pbo",16,0,0,0,GL_UNSIGNED_BYTE); read_pbo("short_pbo",8,0,0,0,GL_UNSIGNED_BYTE);
    read_pbo("mapped_pbo",16,0,1,0,GL_UNSIGNED_BYTE); read_pbo("mapped_undefined",16,0,1,1,GL_UNSIGNED_BYTE);
    read_pbo("misaligned_pbo",64,1,0,0,GL_UNSIGNED_SHORT);
    printf("\n]}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
