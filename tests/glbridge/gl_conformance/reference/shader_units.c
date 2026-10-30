#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <stdlib.h>
static char* read_source(const char* path) {
    FILE* file=fopen(path,"rb"); if(!file)return NULL; fseek(file,0,SEEK_END); long size=ftell(file); rewind(file);
    char* text=malloc(size+1); if(!text||fread(text,1,size,file)!=(size_t)size)return NULL; text[size]=0; fclose(file); return text;
}
int main(int argc,char** argv) {
    if(argc<5)return 2; int vertex=atoi(argv[1]),fragment=atoi(argv[2]); if(argc!=3+vertex+fragment)return 2;
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2; CGLSetCurrentContext(ctx);
    GLuint program=glCreateProgram();
    for(int i=0;i<vertex+fragment;i++) {
        char* text=read_source(argv[i+3]); if(!text)return 3;
        GLuint shader=glCreateShader(i<vertex?GL_VERTEX_SHADER:GL_FRAGMENT_SHADER); const GLchar* source=text;
        glShaderSource(shader,1,&source,NULL); glCompileShader(shader); glGetShaderiv(shader,GL_COMPILE_STATUS,&n);
        if(!n) { char log[4096]; glGetShaderInfoLog(shader,sizeof(log),NULL,log); fprintf(stderr,"%s: %s\n",argv[i+3],log); return 4; }
        glAttachShader(program,shader); free(text);
    }
    glLinkProgram(program); glGetProgramiv(program,GL_LINK_STATUS,&n);
    if(!n) { char log[4096]; glGetProgramInfoLog(program,sizeof(log),NULL,log); fprintf(stderr,"%s\n",log); return 5; }
    GLuint fbo,renderbuffer; glGenFramebuffersEXT(1,&fbo); glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);
    glGenRenderbuffersEXT(1,&renderbuffer); glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,renderbuffer);
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,4,4); glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,renderbuffer);
    if(glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT)!=GL_FRAMEBUFFER_COMPLETE_EXT)return 6;
    glViewport(0,0,4,4); glUseProgram(program); glUniform4f(glGetUniformLocation(program,"tint"),0,0.25,0,1);
    glUniform4f(glGetUniformLocation(program,"settings.tint"),0.25,0.5,0.75,1);
    glUniform4f(glGetUniformLocation(program,"lights[0].color"),0.125,0.25,0.5,1);
    glUniform4f(glGetUniformLocation(program,"lights[1].color"),0.5,0.25,0.125,1);
    GLfloat weights[]={0,0.25,0.5},basis[]={1,0,0,1};
    glUniform1fv(glGetUniformLocation(program,"lights[1].weights"),3,weights);
    glUniformMatrix2fv(glGetUniformLocation(program,"lights[1].basis"),1,GL_FALSE,basis);
    glUniform1i(glGetUniformLocation(program,"chosen"),1);
    glBegin(GL_QUADS); glVertex2f(-1,-1); glVertex2f(1,-1); glVertex2f(1,1); glVertex2f(-1,1); glEnd();
    GLubyte pixel[4]; glReadPixels(1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel); if(glGetError())return 7;
    printf("{\"renderer\":\"%s\",\"compile\":true,\"link\":true,\"pixel\":[%u,%u,%u,%u],\"uniforms\":[",glGetString(GL_RENDERER),pixel[0],pixel[1],pixel[2],pixel[3]);
    glGetProgramiv(program,GL_ACTIVE_UNIFORMS,&n);
    for(GLint i=0;i<n;i++) { char name[1024]; GLint size; GLenum type; glGetActiveUniform(program,i,sizeof(name),NULL,&size,&type,name);
        printf("%s{\"name\":\"%s\",\"size\":%d,\"type\":%u}",i?",":"",name,size,type); }
    printf("]}\n");
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
