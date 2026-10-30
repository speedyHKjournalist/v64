#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static GLfloat buffer[256];static int first=1;
static void begin(int size,GLenum type){
    glMatrixMode(GL_MODELVIEW);glLoadIdentity();glMatrixMode(GL_PROJECTION);glLoadIdentity();glMatrixMode(GL_MODELVIEW);glViewport(2,3,10,20);glDepthRange(0.2,0.8);glDisable(GL_CULL_FACE);glDisable(GL_LIGHTING);glDisable(GL_CLIP_PLANE0);glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);
    glDisable(GL_COLOR_MATERIAL);glDisable(GL_LIGHT0);glEdgeFlag(GL_TRUE);glColor4f(0.25,0.5,0.75,1);glTexCoord4f(2,3,4,5);for(int i=0;i<256;i++)buffer[i]=-12345;
    glFeedbackBuffer(size,type,buffer);glRenderMode(GL_FEEDBACK);
}
static void report(const char* name,int count){
    GLint result=glRenderMode(GL_RENDER);printf("%s{\"name\":\"%s\",\"result\":%d,\"error\":%u,\"values\":[",first?"":",\n",name,result,glGetError());first=0;
    for(int i=0;i<count;i++)printf("%s%.9g",i?",":"",buffer[i]);printf("]}");
}
static void point(void){glBegin(GL_POINTS);glVertex4f(0.5,1,0,2);glEnd();}
static void triangle(void){glBegin(GL_TRIANGLES);glVertex3f(-1,-1,-0.5);glVertex3f(1,-1,0.5);glVertex3f(0,1,0);glEnd();}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,32,32);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    GLenum types[]={GL_2D,GL_3D,GL_3D_COLOR,GL_3D_COLOR_TEXTURE,GL_4D_COLOR_TEXTURE};const char* names[]={"point_2d","point_3d","point_color","point_texture","point_4d"};int sizes[]={3,4,8,12,13};
    for(int i=0;i<5;i++){begin(128,types[i]);point();report(names[i],sizes[i]+2);}
    begin(128,GL_3D_COLOR);glBegin(GL_LINES);glColor3f(1,0,0);glVertex3f(-2,0,-2);glColor3f(0,0,1);glVertex3f(2,0,2);glEnd();report("clipped_line",17);
    begin(128,GL_2D);glBegin(GL_LINE_STRIP);glVertex2f(-0.5,-0.5);glVertex2f(0,0);glVertex2f(0.5,0.5);glEnd();report("line_strip",12);
    begin(128,GL_2D);triangle();report("triangle",10);
    begin(128,GL_2D);glPolygonMode(GL_FRONT_AND_BACK,GL_LINE);triangle();report("polygon_line",19);
    begin(128,GL_2D);glPolygonMode(GL_FRONT_AND_BACK,GL_POINT);triangle();report("polygon_point",11);
    begin(128,GL_2D);glBegin(GL_TRIANGLES);glVertex2f(-2,-0.5);glVertex2f(2,-0.5);glVertex2f(0,2);glEnd();report("clipped_polygon",18);
    begin(128,GL_2D);glEnable(GL_CULL_FACE);glCullFace(GL_FRONT);triangle();report("culled",2);
    begin(128,GL_2D);glPassThrough(3.25);report("pass_through",4);
    begin(128,GL_3D_COLOR_TEXTURE);glWindowPos3f(4,5,0.75);glBitmap(0,0,0,0,3,2,NULL);report("bitmap_zero",14);
    begin(128,GL_2D);GLubyte pixel[]={255,0,0,255};glWindowPos2i(4,5);glDrawPixels(1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);report("draw_pixels",5);
    begin(128,GL_2D);glWindowPos2i(4,5);glCopyPixels(0,0,1,1,GL_COLOR);report("copy_pixels",5);
    for(int size=0;size<=3;size++){begin(size,GL_2D);point();char name[32];snprintf(name,sizeof(name),"overflow_%d",size);report(name,size+2);}
    for(int points=0;points<2;points++){
        begin(128,GL_2D);glPolygonMode(GL_FRONT_AND_BACK,points?GL_POINT:GL_LINE);glBegin(GL_TRIANGLES);glEdgeFlag(GL_FALSE);glVertex2f(-1,-1);glEdgeFlag(GL_TRUE);glVertex2f(1,-1);glVertex2f(0,1);glEnd();report(points?"edge_points":"edge_lines",points?8:12);
    }
    begin(128,GL_3D_COLOR);glEnable(GL_LIGHTING);glEnable(GL_LIGHT0);glEnable(GL_COLOR_MATERIAL);GLfloat pos[]={0.5,1,0,2},col[]={0.5,0.25,0.75,1};glVertexPointer(4,GL_FLOAT,0,pos);glColorPointer(4,GL_FLOAT,0,col);glEnableClientState(GL_VERTEX_ARRAY);glEnableClientState(GL_COLOR_ARRAY);glDrawArrays(GL_POINTS,0,1);report("array_color_material",10);
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
