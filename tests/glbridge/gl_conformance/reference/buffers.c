#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void result(const char* name) { printf("%s\n    \"%s\":%u",first?"":",",name,glGetError()); first=0; }
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n; GLuint b; unsigned char bytes[8]={1,2,3,4,5,6,7,8};
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx); glGenBuffers(1,&b);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    printf("\n    \"reserved\":%u",glIsBuffer(b)); first=0;
    glBufferData(GL_ARRAY_BUFFER,8,bytes,GL_STATIC_DRAW); result("unbound_data");
    glBindBuffer(GL_ARRAY_BUFFER,b); printf(",\n    \"bound\":%u",glIsBuffer(b));
    GLint values[4]; GLenum p[]={GL_BUFFER_SIZE,GL_BUFFER_USAGE,GL_BUFFER_ACCESS,GL_BUFFER_MAPPED};
    for(int i=0;i<4;i++)glGetBufferParameteriv(GL_ARRAY_BUFFER,p[i],&values[i]);
    printf(",\n    \"initial\":[%d,%d,%d,%d]",values[0],values[1],values[2],values[3]);
    glBufferData(GL_ARRAY_BUFFER,8,bytes,GL_STATIC_DRAW); result("valid_data");
    glBufferData(GL_TEXTURE_2D,8,bytes,GL_STATIC_DRAW); result("bad_target");
    glBufferData(GL_ARRAY_BUFFER,-1,bytes,GL_STATIC_DRAW); result("negative_size");
    glBufferData(GL_ARRAY_BUFFER,8,bytes,0); result("bad_usage");
    glBufferSubData(GL_ARRAY_BUFFER,2,2,bytes); result("valid_sub");
    glBufferSubData(GL_ARRAY_BUFFER,-1,1,bytes); result("negative_offset");
    glBufferSubData(GL_ARRAY_BUFFER,0,-1,bytes); result("negative_sub_size");
    glBufferSubData(GL_ARRAY_BUFFER,7,2,bytes); result("past_edge");
    glBufferSubData(GL_ARRAY_BUFFER,8,0,bytes); result("empty_at_edge");
    glBufferSubData(GL_ARRAY_BUFFER,9,0,bytes); result("empty_past_edge");
    glBindBuffer(GL_PIXEL_PACK_BUFFER,b); glGetBufferParameteriv(GL_PIXEL_PACK_BUFFER,GL_BUFFER_SIZE,&n);
    printf(",\n    \"second_target_size\":%d",n);
    glBindBuffer(GL_ARRAY_BUFFER,0); glBufferSubData(GL_ARRAY_BUFFER,0,0,bytes); result("unbound_sub");
    glBindBuffer(GL_ARRAY_BUFFER,b); glMapBuffer(GL_ARRAY_BUFFER,GL_READ_WRITE); result("valid_map");
    glMapBuffer(GL_ARRAY_BUFFER,GL_READ_ONLY); result("already_mapped");
    glBufferSubData(GL_ARRAY_BUFFER,0,1,bytes); result("mapped_sub");
    glGetBufferSubData(GL_ARRAY_BUFFER,0,1,bytes); result("mapped_read");
    glBufferData(GL_ARRAY_BUFFER,8,bytes,GL_DYNAMIC_DRAW); result("replace_mapped");
    glGetBufferParameteriv(GL_ARRAY_BUFFER,GL_BUFFER_MAPPED,&n); printf(",\n    \"reset_mapped\":%d",n);
    glUnmapBuffer(GL_ARRAY_BUFFER); result("not_mapped");
    glMapBuffer(GL_ARRAY_BUFFER,0); result("bad_access");
    glMapBuffer(GL_ARRAY_BUFFER,GL_READ_ONLY); glUnmapBuffer(GL_ARRAY_BUFFER); result("valid_unmap");
    glBindBuffer(GL_ARRAY_BUFFER,b); glBufferData(GL_ARRAY_BUFFER,0,NULL,GL_STREAM_READ); result("zero_size");
    glDeleteBuffers(1,&b); glGetIntegerv(GL_ARRAY_BUFFER_BINDING,&n); printf(",\n    \"deleted_binding\":%d",n);
    glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING,&n); printf(",\n    \"deleted_pack_binding\":%d",n);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
