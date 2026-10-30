#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void report(const char* name,GLuint list) {
    GLint index,mode,base;GLfloat color[4],matrix[16];
    glGetIntegerv(GL_LIST_INDEX,&index);glGetIntegerv(GL_LIST_MODE,&mode);glGetIntegerv(GL_LIST_BASE,&base);
    glGetFloatv(GL_CURRENT_COLOR,color);glGetFloatv(GL_MODELVIEW_MATRIX,matrix);
    printf("%s{\"name\":\"%s\",\"isList\":%u,\"index\":%d,\"mode\":%d,\"base\":%d,\"color\":[%.9g,%.9g,%.9g,%.9g],\"x\":%.9g,\"error\":%u}",first?"":",\n",name,glIsList(list),index,mode,base,color[0],color[1],color[2],color[3],matrix[12],glGetError());first=0;
}
int main(void) {
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    GLuint generated=glGenLists(2);report("generated",generated);glDeleteLists(generated,2);
    glNewList(10,GL_COMPILE);glColor4f(1,0,0,1);glTranslatef(3,0,0);report("compiling",10);glEndList();report("compiled",10);
    glCallList(10);report("called",10);
    glNewList(11,GL_COMPILE);glCallList(10);glEndList();
    glNewList(10,GL_COMPILE);glColor4f(0,1,0,1);glTranslatef(5,0,0);glEndList();glCallList(11);report("nested_redefined",11);
    glNewList(12,GL_COMPILE_AND_EXECUTE);glColor4f(0,0,1,1);glTranslatef(7,0,0);report("compile_execute",12);glEndList();
    glCallList(12);report("executed_again",12);
    glNewList(13,GL_COMPILE);glLineWidth(-1);glEndList();report("deferred_error",13);glCallList(13);report("called_error",13);
    glCallList(0);report("call_zero",0);
    glNewList(14,0);report("invalid_mode",14);glEndList();report("unmatched_end",14);
    glListBase(10);GLubyte offsets[]={0,1};glCallLists(2,GL_UNSIGNED_BYTE,offsets);report("call_lists",10);
    glPushAttrib(GL_LIST_BIT);glListBase(99);glPopAttrib();report("base_restored",10);
    glNewList(15,GL_COMPILE);glPixelStorei(GL_UNPACK_ALIGNMENT,1);glBindBuffer(GL_ARRAY_BUFFER,7);glEndList();GLint alignment,binding;
    glGetIntegerv(GL_UNPACK_ALIGNMENT,&alignment);glGetIntegerv(GL_ARRAY_BUFFER_BINDING,&binding);
    printf(",\n{\"name\":\"immediate\",\"alignment\":%d,\"binding\":%d,\"error\":%u}",alignment,binding,glGetError());
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
