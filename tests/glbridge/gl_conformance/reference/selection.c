#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static GLuint buffer[64];static int first=1;
static void point(GLfloat x,GLfloat y,GLfloat z){glBegin(GL_POINTS);glVertex3f(x,y,z);glEnd();}
static void begin(int size){
    glMatrixMode(GL_MODELVIEW);glLoadIdentity();glMatrixMode(GL_PROJECTION);glLoadIdentity();glMatrixMode(GL_MODELVIEW);glViewport(0,0,16,16);glDepthRange(0,1);glDisable(GL_CULL_FACE);glDisable(GL_CLIP_PLANE0);
    for(int i=0;i<64;i++)buffer[i]=0xA5A5A5A5;glSelectBuffer(size,buffer);glRenderMode(GL_SELECT);glInitNames();glPushName(7);
}
static void report(const char* name,int size){
    GLint result=glRenderMode(GL_RENDER),depth;glGetIntegerv(GL_NAME_STACK_DEPTH,&depth);
    printf("%s{\"name\":\"%s\",\"size\":%d,\"result\":%d,\"error\":%u,\"depth\":%d,\"words\":[",first?"":",\n",name,size,result,glGetError(),depth);first=0;
    for(int i=0;i<size+2;i++)printf("%s%u",i?",":"",buffer[i]);printf("]}");
}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    begin(16);point(0,0,0);report("point",16);begin(16);point(2,0,0);report("outside",16);
    begin(16);glBegin(GL_POINTS);glVertex4f(0,0,0,-1);glEnd();report("negative_w",16);
    begin(16);point(0,0,-0.5f);point(0,0,0.5f);report("merged",16);
    begin(16);point(0,0,-0.5f);glLoadName(7);point(0,0,0.5f);report("same_name_flush",16);
    begin(16);glPopName();point(0,0,0);report("empty_names",16);
    begin(16);glBegin(GL_LINES);glVertex3f(-2,0,-2);glVertex3f(2,0,2);glEnd();report("clipped_line",16);
    begin(16);glDepthRange(0.75,0.25);glBegin(GL_LINES);glVertex3f(-0.5f,0,-0.5f);glVertex3f(0.5f,0,0.5f);glEnd();report("reversed_depth",16);
    begin(16);glBegin(GL_TRIANGLES);glVertex3f(-2,-0.5f,-0.5f);glVertex3f(2,-0.5f,0.5f);glVertex3f(0,2,0);glEnd();report("clipped_triangle",16);
    begin(16);glEnable(GL_CULL_FACE);glCullFace(GL_FRONT);glBegin(GL_TRIANGLES);glVertex3f(-1,-1,0);glVertex3f(1,-1,0);glVertex3f(0,1,0);glEnd();report("culled_front",16);
    begin(16);GLdouble plane[]={1,0,0,-0.25};glClipPlane(GL_CLIP_PLANE0,plane);glEnable(GL_CLIP_PLANE0);point(0,0,0);report("user_clip",16);
    begin(16);glTranslatef(0,0,0.5);point(0,0,0);report("transformed",16);
    for(int size=0;size<=4;size++){begin(size);point(0,0,0);char name[32];snprintf(name,sizeof(name),"overflow_%d",size);report(name,size);}
    begin(16);point(0,0,0);GLint firstResult=glRenderMode(GL_SELECT);point(0,0,0.5);report("reenter",16);fprintf(stderr,"reenter first result=%d\n",firstResult);
    glLoadName(1);glPopName();glPushName(2);glInitNames();printf(",\n{\"name\":\"render_names\",\"error\":%u}",glGetError());
    glBegin(GL_POINTS);glPushName(2);glEnd();printf(",\n{\"name\":\"render_begin_names\",\"error\":%u}",glGetError());
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
