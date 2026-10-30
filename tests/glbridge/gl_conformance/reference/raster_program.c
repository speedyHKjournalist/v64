#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static int first=1;
static void vector(const GLfloat* values,int n){printf("[");for(int i=0;i<n;i++)printf("%s%.9g",i?",":"",values[i]);printf("]");}
static void report(const char* name){
    GLboolean valid;GLfloat p[4],color[4],secondary[4],distance,tex[8][4];glGetBooleanv(GL_CURRENT_RASTER_POSITION_VALID,&valid);
    glGetFloatv(GL_CURRENT_RASTER_POSITION,p);glGetFloatv(GL_CURRENT_RASTER_COLOR,color);glGetFloatv(GL_CURRENT_RASTER_SECONDARY_COLOR,secondary);glGetFloatv(GL_CURRENT_RASTER_DISTANCE,&distance);
    for(int i=0;i<8;i++){glActiveTexture(GL_TEXTURE0+i);glGetFloatv(GL_CURRENT_RASTER_TEXTURE_COORDS,tex[i]);}glActiveTexture(GL_TEXTURE0);
    printf("%s{\"name\":\"%s\",\"error\":%u,\"valid\":%u",first?"":",\n",name,glGetError(),valid);first=0;
    if(valid){printf(",\"position\":");vector(p,4);printf(",\"color\":");vector(color,4);printf(",\"secondary\":");vector(secondary,4);printf(",\"distance\":%.9g,\"coords\":[",distance);for(int i=0;i<8;i++){if(i)printf(",");vector(tex[i],4);}printf("]");}printf("}");
}
static GLuint glsl(void){
    const char* text="#version 120\nuniform float shift;void main(){gl_Position=gl_Vertex;gl_Position.x+=shift;gl_ClipVertex=gl_Vertex;gl_FrontColor=vec4(2,-1,0.5,1);gl_FrontSecondaryColor=gl_SecondaryColor*2.0;gl_FogFragCoord=gl_FogCoord+1.5;gl_TexCoord[0]=gl_MultiTexCoord0+vec4(0.0);gl_TexCoord[1]=gl_MultiTexCoord0+vec4(1.0);gl_TexCoord[2]=gl_MultiTexCoord0+vec4(2.0);gl_TexCoord[3]=gl_MultiTexCoord0+vec4(3.0);gl_TexCoord[4]=gl_MultiTexCoord0+vec4(4.0);gl_TexCoord[5]=gl_MultiTexCoord0+vec4(5.0);gl_TexCoord[6]=gl_MultiTexCoord0+vec4(6.0);gl_TexCoord[7]=gl_MultiTexCoord7;}";
    GLuint p=glCreateProgram(),v=glCreateShader(GL_VERTEX_SHADER);glShaderSource(v,1,&text,NULL);glCompileShader(v);glAttachShader(p,v);glLinkProgram(p);GLint ok;glGetProgramiv(p,GL_LINK_STATUS,&ok);if(!ok){char log[4096];glGetProgramInfoLog(p,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);glGetShaderInfoLog(v,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);return 0;}glUseProgram(p);glUniform1f(glGetUniformLocation(p,"shift"),0.25);return p;
}
static void init(void){glColor4f(0.25,0.5,0.75,1);glSecondaryColor3f(0.125,0.25,0.375);glFogCoordf(2);glMultiTexCoord4f(GL_TEXTURE0,1,2,3,4);glMultiTexCoord4f(GL_TEXTURE7,4,3,2,1);glDisable(GL_CLIP_PLANE0);glDepthRange(0,1);glMatrixMode(GL_MODELVIEW);glLoadIdentity();glMatrixMode(GL_PROJECTION);glLoadIdentity();glMatrixMode(GL_MODELVIEW);}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);glViewport(0,0,16,16);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));init();GLuint p=glsl();if(!p)return 3;
    glRasterPos4f(0.25,0.5,0,1);report("glsl_valid");glRasterPos4f(0.9,0,0,1);report("glsl_outside");glRasterPos4f(0,0,0,-1);report("glsl_negative_w");
    GLdouble plane[]={1,0,0,-0.5};glClipPlane(GL_CLIP_PLANE0,plane);glEnable(GL_CLIP_PLANE0);glRasterPos4f(0.25,0.5,0,1);report("glsl_clip_vertex");glDisable(GL_CLIP_PLANE0);
    glDepthRange(0.75,0.25);glRasterPos4f(0.25,0.5,0.5,1);report("glsl_reversed_depth");glDepthRange(0,1);
    glWindowPos3f(3,4,0.25);report("glsl_window_bypass");
    glUseProgram(0);glDeleteProgram(p);init();
    GLuint vp;glGenProgramsARB(1,&vp);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,vp);
    const char* text="!!ARBvp1.0\nMUL result.position,vertex.position,program.env[0];MOV result.color.front.primary,program.local[0];MUL result.color.front.secondary,vertex.color.secondary,2.0;ADD result.fogcoord,vertex.fogcoord,program.env[1];MOV result.texcoord[0],vertex.texcoord[0];ADD result.texcoord[1],vertex.texcoord[0],1.0;ADD result.texcoord[2],vertex.texcoord[0],2.0;ADD result.texcoord[3],vertex.texcoord[0],3.0;ADD result.texcoord[4],vertex.texcoord[0],4.0;ADD result.texcoord[5],vertex.texcoord[0],5.0;ADD result.texcoord[6],vertex.texcoord[0],6.0;MOV result.texcoord[7],vertex.texcoord[7];END";
    glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(text),text);glProgramEnvParameter4fARB(GL_VERTEX_PROGRAM_ARB,0,2,1,1,1);glProgramEnvParameter4fARB(GL_VERTEX_PROGRAM_ARB,1,1.5,0,0,0);glProgramLocalParameter4fARB(GL_VERTEX_PROGRAM_ARB,0,2,-1,0.5,1);glEnable(GL_VERTEX_PROGRAM_ARB);
    glRasterPos4f(0.25,0.5,0,1);report("arb_valid");glEnable(GL_CLIP_PLANE0);glRasterPos4f(0.25,0.5,0,1);report("arb_user_clip_disabled");glDisable(GL_CLIP_PLANE0);
    glRasterPos4f(0.75,0,0,1);report("arb_outside");glWindowPos3f(3,4,0.25);report("arb_window_bypass");
    glDisable(GL_VERTEX_PROGRAM_ARB);glDeleteProgramsARB(1,&vp);printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
