#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void ints(const char* name, const GLint* values, int count) {
    printf("%s\n    \"%s\":[",first?"":",",name); first=0;
    for(int i=0;i<count;i++)printf("%s%d",i?",":"",values[i]); printf("]");
}
static void error(const char* name) { GLint value=glGetError(); ints(name,&value,1); }
static void vertex(const char* name) {
    GLint values[5]; void* pointer; GLenum p[]={GL_VERTEX_ARRAY_SIZE,GL_VERTEX_ARRAY_TYPE,GL_VERTEX_ARRAY_STRIDE,GL_VERTEX_ARRAY_BUFFER_BINDING};
    for(int i=0;i<4;i++)glGetIntegerv(p[i],values+i); glGetPointerv(GL_VERTEX_ARRAY_POINTER,&pointer); values[4]=(GLint)(uintptr_t)pointer; ints(name,values,5);
}
static void texcoord(const char* name) {
    GLint values[5]; void* pointer; GLenum p[]={GL_TEXTURE_COORD_ARRAY_SIZE,GL_TEXTURE_COORD_ARRAY_TYPE,GL_TEXTURE_COORD_ARRAY_STRIDE,GL_TEXTURE_COORD_ARRAY_BUFFER_BINDING};
    for(int i=0;i<4;i++)glGetIntegerv(p[i],values+i); glGetPointerv(GL_TEXTURE_COORD_ARRAY_POINTER,&pointer); values[4]=(GLint)(uintptr_t)pointer; ints(name,values,5);
}
static void generic(const char* name) {
    GLint values[7]; void* pointer; GLenum p[]={GL_VERTEX_ATTRIB_ARRAY_SIZE,GL_VERTEX_ATTRIB_ARRAY_TYPE,GL_VERTEX_ATTRIB_ARRAY_STRIDE,
        GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,GL_VERTEX_ATTRIB_ARRAY_NORMALIZED,GL_VERTEX_ATTRIB_ARRAY_ENABLED};
    for(int i=0;i<6;i++)glGetVertexAttribiv(3,p[i],values+i); glGetVertexAttribPointerv(3,GL_VERTEX_ATTRIB_ARRAY_POINTER,&pointer); values[6]=(GLint)(uintptr_t)pointer; ints(name,values,7);
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx); printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    vertex("default_vertex"); texcoord("default_texcoord"); generic("default_generic");
    glBindBuffer(GL_ARRAY_BUFFER,7); glVertexPointer(3,GL_SHORT,16,(void*)12); glBindBuffer(GL_ARRAY_BUFFER,0); vertex("vertex_buffer");
    glVertexPointer(1,GL_FLOAT,0,0); error("vertex_size"); glVertexPointer(3,GL_UNSIGNED_BYTE,0,0); error("vertex_type");
    glNormalPointer(GL_UNSIGNED_BYTE,0,0); error("normal_type"); glIndexPointer(GL_UNSIGNED_SHORT,0,0); error("index_type");
    glColorPointer(2,GL_FLOAT,0,0); error("color_size"); glSecondaryColorPointer(4,GL_FLOAT,0,0); error("secondary_size");
    glFogCoordPointer(GL_SHORT,0,0); error("fog_type"); glVertexAttribPointer(3,2,GL_FLOAT,0,-1,0); error("generic_stride");
    glClientActiveTexture(GL_TEXTURE1); glTexCoordPointer(2,GL_DOUBLE,24,(void*)100); texcoord("unit1_texcoord");
    glClientActiveTexture(GL_TEXTURE0); glActiveTexture(GL_TEXTURE1); texcoord("unit0_texcoord");
    glBindBuffer(GL_ARRAY_BUFFER,9); glVertexAttribPointer(3,2,GL_UNSIGNED_SHORT,GL_TRUE,10,(void*)256); glEnableVertexAttribArray(3); generic("generic_buffer");
    glVertexAttrib4f(3,0.25,-2.75,3.5,1); GLint current[4]; glGetVertexAttribiv(3,GL_CURRENT_VERTEX_ATTRIB,current); ints("current_integer",current,4);
    glGetVertexAttribiv(0,GL_CURRENT_VERTEX_ATTRIB,current); error("current_zero");
    glPushClientAttrib(GL_CLIENT_VERTEX_ARRAY_BIT); glVertexAttribPointer(3,4,GL_FLOAT,GL_FALSE,0,(void*)512); glDisableVertexAttribArray(3);
    glVertexAttrib4f(3,7,8,9,10); glPopClientAttrib(); generic("restored_generic"); glGetVertexAttribiv(3,GL_CURRENT_VERTEX_ATTRIB,current); ints("client_keeps_current",current,4);
    glPushAttrib(GL_CURRENT_BIT); glVertexAttrib4f(3,1,2,3,4); glPopAttrib(); glGetVertexAttribiv(3,GL_CURRENT_VERTEX_ATTRIB,current); ints("restored_current",current,4);
    GLuint deleted=7; glDeleteBuffers(1,&deleted); vertex("deleted_buffer");
    glBindBuffer(GL_ARRAY_BUFFER,7); glEnableClientState(GL_INDEX_ARRAY); glEnableClientState(GL_EDGE_FLAG_ARRAY);
    glInterleavedArrays(GL_C4UB_V3F,0,NULL); vertex("interleaved_zero_offset");
    GLint enabled[2]; glGetIntegerv(GL_INDEX_ARRAY,enabled); glGetIntegerv(GL_EDGE_FLAG_ARRAY,enabled+1); ints("interleaved_disables",enabled,2);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
