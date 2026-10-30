#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void result(const char* name, GLenum target, GLint level) {
    GLenum error=glGetError(); GLint w=0,h=0,d=0,b=0,f=0;
    glGetTexLevelParameteriv(target,level,GL_TEXTURE_WIDTH,&w);
    glGetTexLevelParameteriv(target,level,GL_TEXTURE_HEIGHT,&h);
    glGetTexLevelParameteriv(target,level,GL_TEXTURE_DEPTH,&d);
    glGetTexLevelParameteriv(target,level,GL_TEXTURE_BORDER,&b);
    glGetTexLevelParameteriv(target,level,GL_TEXTURE_INTERNAL_FORMAT,&f);
    printf("%s\n    \"%s\":[%u,%d,%d,%d,%d,%d]",first?"":",",name,error,w,h,d,b,f); first=0;
    if(glGetError())fprintf(stderr,"query error: %s\n",name);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n; GLuint t[8];
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx); glGenTextures(8,t);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    glBindTexture(GL_TEXTURE_2D,t[0]); glGenerateMipmapEXT(GL_TEXTURE_2D); result("undefined",GL_TEXTURE_2D,1);
    glGenerateMipmapEXT(GL_PROXY_TEXTURE_2D); result("proxy_target",GL_TEXTURE_2D,1);
    glTexImage2D(GL_TEXTURE_2D,2,GL_RGBA8,8,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glTexImage2D(GL_TEXTURE_2D,5,GL_RGB8,1,1,0,GL_RGB,GL_UNSIGNED_BYTE,NULL);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_BASE_LEVEL,2); glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAX_LEVEL,4);
    glGenerateMipmapEXT(GL_TEXTURE_2D); result("nonzero_base",GL_TEXTURE_2D,3); result("maximum",GL_TEXTURE_2D,4); result("beyond_maximum",GL_TEXTURE_2D,5);
    glTexParameteri(GL_TEXTURE_2D,GL_GENERATE_MIPMAP,1);
    GLubyte pixels[64*32*4]={0};
    glTexImage2D(GL_TEXTURE_2D,2,GL_RGBA8,4,2,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels); result("auto_base",GL_TEXTURE_2D,3);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,64,32,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels); result("auto_other",GL_TEXTURE_2D,3);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAX_LEVEL,1); glGenerateMipmapEXT(GL_TEXTURE_2D); result("inverted_range",GL_TEXTURE_2D,3);
    glBindTexture(GL_TEXTURE_2D,t[1]); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,10,6,1,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_2D); result("border_level1",GL_TEXTURE_2D,1); result("border_level3",GL_TEXTURE_2D,3);
    glBindTexture(GL_TEXTURE_CUBE_MAP,t[2]); glGenerateMipmapEXT(GL_TEXTURE_CUBE_MAP); result("cube_empty",GL_TEXTURE_CUBE_MAP_POSITIVE_X,1);
    for(int face=0;face<5;face++) glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X+face,0,GL_RGBA8,8,8,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_CUBE_MAP); result("cube_missing",GL_TEXTURE_CUBE_MAP_POSITIVE_X,1);
    glTexImage2D(GL_TEXTURE_CUBE_MAP_NEGATIVE_Z,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_CUBE_MAP); result("cube_size",GL_TEXTURE_CUBE_MAP_POSITIVE_X,1);
    glTexImage2D(GL_TEXTURE_CUBE_MAP_NEGATIVE_Z,0,GL_RGB8,8,8,0,GL_RGB,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_CUBE_MAP); result("cube_format",GL_TEXTURE_CUBE_MAP_POSITIVE_X,1);
    glTexImage2D(GL_TEXTURE_CUBE_MAP_NEGATIVE_Z,0,GL_RGBA8,8,8,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_CUBE_MAP); result("cube_complete",GL_TEXTURE_CUBE_MAP_NEGATIVE_Z,3);
    glBindTexture(GL_TEXTURE_3D,t[3]); glTexImage3D(GL_TEXTURE_3D,0,GL_RGBA8,9,5,3,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenerateMipmapEXT(GL_TEXTURE_3D); result("volume",GL_TEXTURE_3D,1);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
