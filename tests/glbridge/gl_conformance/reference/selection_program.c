#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>

static int first = 1;
static GLuint program(int fragment) {
    const char *source = "#version 120\nuniform float scale;void main(){gl_Position=gl_Vertex;gl_Position.x*=scale;gl_FrontColor=vec4(2,-1,0.5,1);gl_BackColor=vec4(0.25,0.5,0.75,1);gl_TexCoord[0]=gl_MultiTexCoord0+gl_MultiTexCoord1;gl_ClipVertex=gl_Vertex;}";
    const char *fs = "#version 120\nvoid main(){gl_FragColor=vec4(1);}";
    GLuint p=glCreateProgram(), v=glCreateShader(GL_VERTEX_SHADER); glShaderSource(v,1,&source,NULL);glCompileShader(v);glAttachShader(p,v);
    if(fragment){GLuint f=glCreateShader(GL_FRAGMENT_SHADER);glShaderSource(f,1,&fs,NULL);glCompileShader(f);glAttachShader(p,f);}
    glLinkProgram(p);GLint ok;glGetProgramiv(p,GL_LINK_STATUS,&ok);if(!ok)return 0;glUseProgram(p);glUniform1f(glGetUniformLocation(p,"scale"),2);return p;
}
static void report(const char *name,int feedback,int triangle){
    GLuint words[64]={0};GLfloat values[64]={0};
    if(feedback)glFeedbackBuffer(64,GL_4D_COLOR_TEXTURE,values);else glSelectBuffer(64,words);
    glRenderMode(feedback?GL_FEEDBACK:GL_SELECT);glInitNames();glPushName(7);
    glMultiTexCoord4f(GL_TEXTURE0,1,2,3,4);glMultiTexCoord4f(GL_TEXTURE1,4,3,2,1);
    glBegin(triangle?GL_TRIANGLES:GL_POINTS);
    if(triangle){glVertex3f(-0.25f,-0.5f,0);glVertex3f(0,0.5f,0);glVertex3f(0.25f,-0.5f,0);}else glVertex3f(feedback?0.25f:0.75f,0,0);
    glEnd();GLint result=glRenderMode(GL_RENDER);
    printf("%s{\"name\":\"%s\",\"result\":%d,\"error\":%u,\"values\":[",first?"":",\n",name,result,glGetError());first=0;
    int count=feedback&&result>0?result:result>0?4:0;for(int i=0;i<count;i++){if(feedback)printf("%s%.9g",i?",":"",values[i]);else printf("%s%u",i?",":"",words[i]);}printf("]}");
}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    glViewport(0,0,16,16);printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    for(int fragment=0;fragment<2;fragment++){
        GLuint p=program(fragment);if(!p)return 3;char label[64];snprintf(label,sizeof(label),"glsl_%s_select",fragment?"fragment":"vertex");report(label,0,0);
        snprintf(label,sizeof(label),"glsl_%s_feedback",fragment?"fragment":"vertex");report(label,1,0);
        glEnable(GL_VERTEX_PROGRAM_TWO_SIDE);snprintf(label,sizeof(label),"glsl_%s_back",fragment?"fragment":"vertex");report(label,1,1);glDisable(GL_VERTEX_PROGRAM_TWO_SIDE);
        glUseProgram(0);glDeleteProgram(p);
    }
    GLuint vp;glGenProgramsARB(1,&vp);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,vp);
    const char *assembly="!!ARBvp1.0\nMUL result.position,vertex.position,program.env[0];MOV result.color.front.primary,program.local[0];MOV result.color.back.primary,vertex.color;ADD result.texcoord[0],vertex.texcoord[0],vertex.texcoord[1];END";
    glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(assembly),assembly);
    glProgramEnvParameter4fARB(GL_VERTEX_PROGRAM_ARB,0,2,1,1,1);glProgramLocalParameter4fARB(GL_VERTEX_PROGRAM_ARB,0,2,-1,0.5,1);glColor4f(0.25,0.5,0.75,1);glEnable(GL_VERTEX_PROGRAM_ARB);
    report("arb_select",0,0);report("arb_feedback",1,0);glEnable(GL_VERTEX_PROGRAM_TWO_SIDE);report("arb_back",1,1);glDisable(GL_VERTEX_PROGRAM_TWO_SIDE);
    GLuint p=program(0);glUniform1f(glGetUniformLocation(p,"scale"),0.5);report("glsl_over_arb_select",0,0);glUseProgram(0);glDeleteProgram(p);
    glDisable(GL_VERTEX_PROGRAM_ARB);glDeleteProgramsARB(1,&vp);
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
