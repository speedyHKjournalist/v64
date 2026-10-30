#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, GLenum attachment, GLenum pname) {
    GLint v = 1234567; glGetFramebufferAttachmentParameterivEXT(GL_FRAMEBUFFER_EXT, attachment, pname, &v);
    GLenum error = glGetError();
    printf("%s\n    \"%s\":[%d,%u]", first ? "" : ",", name, v, error); first = 0;
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"version\":\"%s\",\n  \"cases\":{", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, 3);
    query("empty_type", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT);
    query("empty_name", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT);
    query("empty_level", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT);
    glBindTexture(GL_TEXTURE_2D, 11); glTexImage2D(GL_TEXTURE_2D, 2, GL_RGBA8, 4, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, 11, 2);
    query("texture_type", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT);
    query("texture_name", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT);
    query("texture_level", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT);
    query("texture_face", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE_EXT);
    query("texture_z", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_3D_ZOFFSET_EXT);
    glBindTexture(GL_TEXTURE_CUBE_MAP, 12); glTexImage2D(GL_TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, GL_RGBA8, 4, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT1_EXT, GL_TEXTURE_CUBE_MAP_NEGATIVE_Z, 12, 0);
    query("cube_face", GL_COLOR_ATTACHMENT1_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE_EXT);
    glBindTexture(GL_TEXTURE_3D, 13); glTexImage3D(GL_TEXTURE_3D, 0, GL_RGBA8, 4, 4, 3, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT2_EXT, GL_TEXTURE_3D, 13, 0, 1);
    query("volume_z", GL_COLOR_ATTACHMENT2_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_3D_ZOFFSET_EXT);
    glBindRenderbufferEXT(GL_RENDERBUFFER_EXT, 15); glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT, GL_DEPTH_COMPONENT24, 4, 4);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, 15);
    query("renderbuffer_type", GL_DEPTH_ATTACHMENT_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT);
    query("renderbuffer_name", GL_DEPTH_ATTACHMENT_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT);
    query("renderbuffer_level", GL_DEPTH_ATTACHMENT_EXT, GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT);
    query("bad_attachment", 0, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT);
    query("bad_pname", GL_COLOR_ATTACHMENT0_EXT, 0);
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, 0); query("default", GL_COLOR_ATTACHMENT0_EXT, GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
