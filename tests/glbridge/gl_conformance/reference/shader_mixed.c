#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <stdlib.h>
static char* read_source(const char* path) {
    FILE* f=fopen(path,"rb");if(!f)return NULL;fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);
    char* s=malloc(n+1);if(!s||fread(s,1,n,f)!=(size_t)n)return NULL;s[n]=0;fclose(f);return s;
}
int main(int argc,char** argv) {
    if(argc!=4)return 2;int scene=atoi(argv[1]);GLenum type=atoi(argv[2]);char* text=read_source(argv[3]);if(!text)return 2;
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint program=glCreateProgram(),shader=glCreateShader(type);const GLchar* source=text;
    glShaderSource(shader,1,&source,NULL);glCompileShader(shader);glGetShaderiv(shader,GL_COMPILE_STATUS,&n);if(!n)return 3;
    glAttachShader(program,shader);glLinkProgram(program);glGetProgramiv(program,GL_LINK_STATUS,&n);if(!n)return 4;
    GLuint fbo,rb;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glGenRenderbuffersEXT(1,&rb);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,rb);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,8,8);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,rb);glViewport(0,0,8,8);
    glUseProgram(program);glColor4f(0.25,0.5,0.75,1);glNormal3f(0,0,1);glFogCoordf(0.375);glSecondaryColor3f(0.2,0.4,0.6);glMultiTexCoord4f(GL_TEXTURE3,0.1,0.2,0.3,1);
    if(scene==0)glEnable(GL_LIGHTING);
    if(scene==1||scene==10||scene==13) {
        GLubyte pixels[]={255,0,0,255,0,255,0,255,0,0,255,255,128,255,64,255};
        glEnable(GL_TEXTURE_2D);glBindTexture(GL_TEXTURE_2D,1);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
        glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
        if(scene==10||scene==13) {
            GLubyte pixels[]={255,128,255,255};glActiveTexture(GL_TEXTURE1);glBindTexture(GL_TEXTURE_2D,2);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
            glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels);glActiveTexture(GL_TEXTURE0);glUniform1i(glGetUniformLocation(program,"probe"),1);
        }
    }
    if(scene==2) { GLfloat color[]={0,0,1,1};glEnable(GL_FOG);glFogi(GL_FOG_MODE,GL_LINEAR);glFogf(GL_FOG_START,0);glFogf(GL_FOG_END,1);glFogfv(GL_FOG_COLOR,color); }
    if(scene==3)glEnable(GL_COLOR_SUM);
    if(scene==6) { GLfloat plane[]={0,0,0,0.25};glActiveTexture(GL_TEXTURE3);glEnable(GL_TEXTURE_GEN_S);glTexGeni(GL_S,GL_TEXTURE_GEN_MODE,GL_OBJECT_LINEAR);glTexGenfv(GL_S,GL_OBJECT_PLANE,plane);
        glMatrixMode(GL_TEXTURE);glTranslatef(0.25,0,0);glMatrixMode(GL_MODELVIEW);glActiveTexture(GL_TEXTURE0); }
    if(scene==7) { GLfloat diffuse[]={0.2,0.4,0.6,1},one[]={1,1,1,1},zero[]={0,0,0,1};glEnable(GL_LIGHTING);glEnable(GL_LIGHT0);glLightfv(GL_LIGHT0,GL_DIFFUSE,diffuse);
        glMaterialfv(GL_FRONT_AND_BACK,GL_DIFFUSE,one);glMaterialfv(GL_FRONT_AND_BACK,GL_AMBIENT,zero); }
    if(scene==8)glFogi(GL_FOG_COORD_SRC,GL_FOG_COORD);
    if(scene==11)glEnable(GL_VERTEX_PROGRAM_TWO_SIDE);
    glBegin(GL_QUADS);
    if(scene==4||scene==11||scene==12){glVertex2f(-1,1);glVertex2f(1,1);glVertex2f(1,-1);glVertex2f(-1,-1);}
    else {glVertex2f(-1,-1);glVertex2f(1,-1);glVertex2f(1,1);glVertex2f(-1,1);}glEnd();
    GLubyte pixel[4];glReadPixels(3,3,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);GLenum error=glGetError();
    printf("{\"renderer\":\"%s\",\"compile\":true,\"link\":true,\"error\":%u,\"pixel\":[%u,%u,%u,%u]}\n",glGetString(GL_RENDERER),error,pixel[0],pixel[1],pixel[2],pixel[3]);
    CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return error?5:0;
}
