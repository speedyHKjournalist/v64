#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static void texture(GLuint name,GLint format,GLsizei width,GLsizei height,GLint border) {
    glBindTexture(GL_TEXTURE_2D,name); glTexImage2D(GL_TEXTURE_2D,0,format,width,height,border,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2; CGLSetCurrentContext(ctx);
    GLuint fbo; glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    const struct { const char* name; GLint format,second; GLsizei width,height; GLint border; } cases[]={
        {"rgba8",GL_RGBA8,0,4,4,0},{"rgb8",GL_RGB8,0,4,4,0},{"luminance8",GL_LUMINANCE8,0,4,4,0},
        {"alpha8",GL_ALPHA8,0,4,4,0},{"intensity8",GL_INTENSITY8,0,4,4,0},{"luminance_alpha8",GL_LUMINANCE8_ALPHA8,0,4,4,0},
        {"rgba4",GL_RGBA4,0,4,4,0},{"rgb5_a1",GL_RGB5_A1,0,4,4,0},{"rgba16f",GL_RGBA16F_ARB,0,4,4,0},
        {"rgba32f",GL_RGBA32F_ARB,0,4,4,0},{"zero_width",GL_RGBA8,0,0,4,0},{"border",GL_RGBA8,0,6,6,1},
        {"same_formats",GL_RGBA8,GL_RGBA8,4,4,0},{"different_channels",GL_RGBA8,GL_RGB8,4,4,0},
        {"different_precision",GL_RGBA8,GL_RGBA4,4,4,0},{"different_numeric_type",GL_RGBA8,GL_RGBA16F_ARB,4,4,0},
    };
    printf("{\"renderer\":\"%s\",\"arbFramebuffer\":%s,\"cases\":[\n",glGetString(GL_RENDERER),strstr((const char*)glGetString(GL_EXTENSIONS),"GL_ARB_framebuffer_object")?"true":"false");
    for(unsigned int i=0;i<sizeof(cases)/sizeof(cases[0]);i++) {
        glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT1_EXT,GL_TEXTURE_2D,0,0);
        texture(1,cases[i].format,cases[i].width,cases[i].height,cases[i].border);
        GLenum imageError=glGetError(); glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0);
        if(cases[i].second) { texture(2,cases[i].second,4,4,0); glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT1_EXT,GL_TEXTURE_2D,2,0); }
        GLenum error=glGetError(),status=glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT);
        glClearColor(0.25,0.5,0.75,1); glClear(GL_COLOR_BUFFER_BIT); GLenum clearError=glGetError();
        GLubyte pixel[]={0xA5,0xA5,0xA5,0xA5}; glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel); GLenum readError=glGetError();
        printf("%s{\"name\":\"%s\",\"format\":%d,\"secondFormat\":%d,\"width\":%d,\"height\":%d,\"border\":%d,\"imageError\":%u,\"error\":%u,\"status\":%u,\"clearError\":%u,\"readError\":%u,\"readPreserved\":%s}",i?",\n":"",cases[i].name,cases[i].format,cases[i].second,cases[i].width,cases[i].height,cases[i].border,imageError,error,status,clearError,readError,pixel[0]==0xA5&&pixel[1]==0xA5&&pixel[2]==0xA5&&pixel[3]==0xA5?"true":"false");
    }
    printf("\n]}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
