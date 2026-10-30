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
    CGLSetCurrentContext(ctx);
    GLuint source, fbo, depth, destination;
    glGenTextures(1,&source); glBindTexture(GL_TEXTURE_2D,source); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,source,0);
    glGenRenderbuffersEXT(1,&depth); glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,depth); glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH_COMPONENT16,4,4);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,depth);
    glReadBuffer(GL_COLOR_ATTACHMENT0_EXT); glDrawBuffer(GL_COLOR_ATTACHMENT0_EXT); glViewport(0,0,4,4);
    if(glGetError()||glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT)!=GL_FRAMEBUFFER_COMPLETE_EXT)return 3;
    glGenTextures(1,&destination); glBindTexture(GL_TEXTURE_2D,destination);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,2,2,0); result("valid");
    glCopyTexImage2D(GL_TEXTURE_CUBE_MAP,0,GL_RGBA8,0,0,2,2,0); result("target");
    glCopyTexImage2D(GL_TEXTURE_2D,-1,GL_RGBA8,0,0,2,2,0); result("negative_level");
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,-1,2,0); result("negative_width");
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,2,2,2); result("bad_border");
    glCopyTexImage2D(GL_TEXTURE_2D,0,0,0,0,2,2,0); result("bad_internal");
    glCopyTexImage2D(GL_TEXTURE_2D,0,1,0,0,2,2,0); result("legacy_internal");
    glCopyTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X,0,GL_RGBA8,0,0,4,2,0); result("cube_rectangle");
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT16,0,0,2,2,0); result("depth");
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,-2,-2,2,2,0); result("outside_source");
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); if(glGetError())return 3;
    glCopyTexSubImage2D(GL_TEXTURE_2D,0,1,1,0,0,2,2); result("sub_valid");
    glCopyTexSubImage2D(GL_TEXTURE_2D,1,0,0,0,0,1,1); result("undefined_level");
    glCopyTexSubImage2D(GL_TEXTURE_2D,0,-1,0,0,0,1,1); result("negative_offset");
    glCopyTexSubImage2D(GL_TEXTURE_2D,0,3,0,0,0,2,1); result("past_edge");
    glCopyTexSubImage2D(GL_TEXTURE_2D,0,4,0,0,0,0,1); result("empty_at_edge");
    glReadBuffer(GL_NONE);
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,2,2,0); result("read_none_color");
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT16,0,0,2,2,0); result("read_none_depth");
    glReadBuffer(GL_COLOR_ATTACHMENT0_EXT); glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,0);
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT16,0,0,2,2,0); result("missing_depth");
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,0,0);
    glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,2,2,0); result("incomplete_source");
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
