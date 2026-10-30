#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void image(const char* name, GLenum target, GLint level, GLint internal, GLsizei width, GLsizei height,
                  GLint border, GLenum format, GLenum type) {
    glTexImage2D(target,level,internal,width,height,border,format,type,NULL);
    printf("%s\n    \"%s\":%u",first?"":",",name,glGetError()); first=0;
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    image("valid",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("target",GL_TEXTURE_CUBE_MAP,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("negative_level",GL_TEXTURE_2D,-1,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("large_level",GL_TEXTURE_2D,1000,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("negative_width",GL_TEXTURE_2D,0,GL_RGBA8,-1,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("border2",GL_TEXTURE_2D,0,GL_RGBA8,4,4,2,GL_RGBA,GL_UNSIGNED_BYTE);
    image("border_too_large",GL_TEXTURE_2D,0,GL_RGBA8,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE);
    image("bad_internal",GL_TEXTURE_2D,0,0,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("bgr_internal",GL_TEXTURE_2D,0,GL_BGR,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("rgb565_internal",GL_TEXTURE_2D,0,0x8D62,4,4,0,GL_RGB,GL_UNSIGNED_SHORT_5_6_5);
    image("bad_format",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,0,GL_UNSIGNED_BYTE);
    image("bad_type",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,0);
    image("bgr565",GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_BGR,GL_UNSIGNED_SHORT_5_6_5);
    image("rgb565",GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_RGB,GL_UNSIGNED_SHORT_5_6_5);
    image("rgba565",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_SHORT_5_6_5);
    image("bgra4444",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_BGRA,GL_UNSIGNED_SHORT_4_4_4_4);
    image("rgb4444",GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_RGB,GL_UNSIGNED_SHORT_4_4_4_4);
    image("bitmap_rgb",GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_RGB,GL_BITMAP);
    image("bitmap_index",GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_COLOR_INDEX,GL_BITMAP);
    image("depth_as_color",GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_DEPTH_COMPONENT,GL_FLOAT);
    image("color_as_depth",GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT16,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE);
    image("cube_rectangle",GL_TEXTURE_CUBE_MAP_POSITIVE_X,0,GL_RGBA8,4,2,0,GL_RGBA,GL_UNSIGNED_BYTE);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
