#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
extern void glBindFramebuffer(GLenum,GLuint);
extern GLboolean glIsFramebuffer(GLuint);
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj first,second; GLint n,attachment=0; GLuint names[2];
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&first)||CGLCreateContext(pf,first,&second))return 2;
    CGLSetCurrentContext(first); glGenFramebuffersEXT(2,names);
    glBindTexture(GL_TEXTURE_2D,1); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,names[0]); glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0);
    glBindFramebuffer(GL_FRAMEBUFFER_EXT,names[1]); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,names[1]);
    GLboolean ownCoreViaEXT=glIsFramebufferEXT(names[1]); GLenum setupError=glGetError();
    CGLSetCurrentContext(second); GLboolean foreignEXT=glIsFramebufferEXT(names[0]),foreignCore=glIsFramebuffer(names[1]);
    glBindFramebuffer(GL_FRAMEBUFFER_EXT,names[0]); GLenum bindError=glGetError();
    glGetFramebufferAttachmentParameterivEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT,&attachment);
    GLenum queryError=glGetError();
    printf("{\"renderer\":\"%s\",\"setupError\":%u,\"foreignEXT\":%u,\"foreignCore\":%u,\"ownCoreViaEXT\":%u,\"crossBindError\":%u,\"crossAttachment\":%d,\"crossQueryError\":%u}\n",
        glGetString(GL_RENDERER),setupError,foreignEXT,foreignCore,ownCoreViaEXT,bindError,attachment,queryError);
    CGLSetCurrentContext(NULL); CGLDestroyContext(second); CGLDestroyContext(first); CGLDestroyPixelFormat(pf); return 0;
}
