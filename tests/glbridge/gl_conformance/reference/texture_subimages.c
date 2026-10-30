#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void result(const char* name) { printf("%s\n    \"%s\":%u",first?"":",",name,glGetError()); first=0; }
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx); unsigned char data[1024]={0};
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); if(glGetError())return 3;
    glTexSubImage2D(GL_TEXTURE_2D,0,1,1,2,2,GL_RGBA,GL_UNSIGNED_BYTE,data); result("valid");
    glTexSubImage2D(GL_TEXTURE_2D,1,0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("undefined_level");
    glTexSubImage2D(GL_TEXTURE_2D,0,-1,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("negative_offset");
    glTexSubImage2D(GL_TEXTURE_2D,0,3,0,2,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("past_edge");
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,-1,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("negative_width");
    glTexSubImage2D(GL_TEXTURE_2D,0,4,0,0,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("empty_at_edge");
    glTexSubImage2D(GL_TEXTURE_2D,0,5,0,0,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("empty_past_edge");
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,1,1,0,GL_UNSIGNED_BYTE,data); result("bad_format");
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,1,1,GL_RGBA,0,data); result("bad_type");
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,1,1,GL_DEPTH_COMPONENT,GL_FLOAT,data); result("depth_as_color");
    glTexImage3D(GL_TEXTURE_3D,0,GL_RGBA8,4,4,2,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); if(glGetError())return 3;
    glTexSubImage3D(GL_TEXTURE_3D,0,0,0,1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("valid_3d");
    glTexSubImage3D(GL_TEXTURE_3D,0,0,0,2,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,data); result("past_slice");
    glCompressedTexImage2D(GL_TEXTURE_2D,0,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,8,0,32,data); if(glGetError())return 3;
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,0,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,data); result("compressed_valid");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,1,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,data); result("compressed_unaligned");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,0,0,2,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,data); result("compressed_partial_block");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,4,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,data); result("compressed_edge");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,8,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,data); result("compressed_past_edge");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,0,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,7,data); result("compressed_bad_size");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,0,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT3_EXT,16,data); result("compressed_wrong_format");
    glCompressedTexSubImage2D(GL_TEXTURE_2D,0,0,0,4,4,GL_RGBA,8,data); result("compressed_unknown_format");
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,2,4,GL_RGBA,GL_UNSIGNED_BYTE,data); result("ordinary_partial_origin");
    glTexSubImage2D(GL_TEXTURE_2D,0,4,0,2,4,GL_RGBA,GL_UNSIGNED_BYTE,data); result("ordinary_partial_non_origin");
    glBindTexture(GL_TEXTURE_2D,17);
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,0,0,GL_RGBA,GL_UNSIGNED_BYTE,data); result("undefined_empty");
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
