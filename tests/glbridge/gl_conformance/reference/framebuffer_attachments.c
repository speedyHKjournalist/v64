#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static GLuint fbo; static int first=1;
static void reset(void) { glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo); glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0); while(glGetError()){} }
static void record(const char* name) {
    GLenum error=glGetError(); GLint type=0,object=0,level=0;
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glGetFramebufferAttachmentParameterivEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT,&type);
    if(type)glGetFramebufferAttachmentParameterivEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT,&object);
    if(type==GL_TEXTURE)glGetFramebufferAttachmentParameterivEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT,&level);
    GLenum status=glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT);
    printf("%s{\"name\":\"%s\",\"error\":%u,\"objectType\":%d,\"objectName\":%d,\"level\":%d,\"status\":%u}",first?"":",\n",name,error,type,object,level,status); first=0;
}
#define CASE(name,call) do { reset(); call; record(name); } while(0)
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n,maxTex,maxCube,max3D,maxColors;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2; CGLSetCurrentContext(ctx);
    glGetIntegerv(GL_MAX_TEXTURE_SIZE,&maxTex); glGetIntegerv(GL_MAX_CUBE_MAP_TEXTURE_SIZE,&maxCube);
    glGetIntegerv(GL_MAX_3D_TEXTURE_SIZE,&max3D); glGetIntegerv(GL_MAX_COLOR_ATTACHMENTS_EXT,&maxColors);
    GLuint textures[4],rb[2]; glGenTextures(4,textures); glGenRenderbuffersEXT(2,rb);
    glBindTexture(GL_TEXTURE_2D,1); glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glBindTexture(GL_TEXTURE_1D,2); glTexImage1D(GL_TEXTURE_1D,0,GL_RGBA8,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glBindTexture(GL_TEXTURE_3D,3); glTexImage3D(GL_TEXTURE_3D,0,GL_RGBA8,4,4,2,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,rb[0]); glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,4,4);
    glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    printf("{\"renderer\":\"%s\",\"maxTexture\":%d,\"maxCube\":%d,\"max3D\":%d,\"maxColors\":%d,\"cases\":[\n",glGetString(GL_RENDERER),maxTex,maxCube,max3D,maxColors);
    CASE("valid_2d",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0));
    CASE("bad_target",glFramebufferTexture2DEXT(0,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0));
    CASE("bad_attachment",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,0,GL_TEXTURE_2D,1,0));
    CASE("attachment_limit",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT+maxColors,GL_TEXTURE_2D,1,0));
    CASE("default_framebuffer",(glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,0),glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0)));
    CASE("bad_textarget",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,0,1,0));
    CASE("wrong_object_target",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,2,0));
    CASE("missing_texture",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,100,0));
    CASE("reserved_texture",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,4,0));
    CASE("negative_level",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,-1));
    CASE("large_level",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,99));
    CASE("undefined_level",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,1));
    CASE("wrong_2d_function",glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_1D,2,0));
    CASE("valid_1d",glFramebufferTexture1DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_1D,2,0));
    CASE("wrong_1d_function",glFramebufferTexture1DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,1,0));
    CASE("valid_3d",glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,3,0,1));
    CASE("undefined_slice",glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,3,0,max3D-1));
    CASE("negative_slice",glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,3,0,-1));
    CASE("large_slice",glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,3,0,max3D));
    CASE("zero_texture_ignored_arguments",glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,0,0,-1,-1));
    CASE("valid_renderbuffer",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,rb[0]));
    CASE("bad_rb_target",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,0,rb[0]));
    CASE("missing_renderbuffer",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,100));
    CASE("reserved_renderbuffer",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,rb[1]));
    CASE("zero_rb_bad_target",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,0,0));
    CASE("zero_renderbuffer",glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,0));
    printf("\n]}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
