#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void record(const char* name) {
    const GLenum pnames[]={GL_RED_BITS,GL_GREEN_BITS,GL_BLUE_BITS,GL_ALPHA_BITS,GL_DEPTH_BITS,GL_STENCIL_BITS,GL_SAMPLE_BUFFERS,GL_SAMPLES};
    printf("%s{\"name\":\"%s\",\"queries\":[",first?"":",\n",name); first=0;
    for(unsigned int i=0;i<sizeof(pnames)/sizeof(pnames[0]);i++) { GLint value=-999; glGetIntegerv(pnames[i],&value); GLenum error=glGetError();
        printf("%s{\"pname\":%u,\"value\":%d,\"error\":%u}",i?",":"",pnames[i],value,error); }
    printf("]}");
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,kCGLPFAAlphaSize,8,kCGLPFADepthSize,24,kCGLPFAStencilSize,8,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2; CGLSetCurrentContext(ctx);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER)); record("window");
    GLuint fbo,rb; glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glBindTexture(GL_TEXTURE_2D,1); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0); record("rgba8");
    glDrawBuffer(GL_NONE); record("draw_none");
    GLenum draws[]={GL_NONE,GL_COLOR_ATTACHMENT0_EXT}; glDrawBuffers(2,draws); record("first_none"); glDrawBuffer(GL_COLOR_ATTACHMENT0_EXT);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGB8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); record("rgb8");
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA4,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); record("rgba4");
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenRenderbuffersEXT(1,&rb); glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,rb); glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH_COMPONENT16,4,4);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,rb); record("depth_renderbuffer16");
    glBindTexture(GL_TEXTURE_2D,2); glTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT24,4,4,0,GL_DEPTH_COMPONENT,GL_FLOAT,NULL);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_TEXTURE_2D,2,0); record("depth_texture24");
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8_EXT,4,4);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,rb);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,rb); record("packed_renderbuffer");
    glBindTexture(GL_TEXTURE_2D,3); glTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH24_STENCIL8_EXT,4,4,0,GL_DEPTH_STENCIL_EXT,GL_UNSIGNED_INT_24_8_EXT,NULL);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_TEXTURE_2D,3,0);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_TEXTURE_2D,3,0); record("packed_texture");
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,0,0); glDrawBuffer(GL_NONE); glReadBuffer(GL_NONE); record("no_color");
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_TEXTURE_2D,0,0);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_TEXTURE_2D,0,0); record("empty");
    printf("\n]}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
