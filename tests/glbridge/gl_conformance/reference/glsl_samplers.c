#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <stdio.h>
// This oracle records assignment/query behavior only. Runtime sampler
// validation is checked against GL 2.1 section 2.15.4 and browser pixels.
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy, 0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if (CGLChoosePixelFormat(a, &pf, &n) || CGLCreateContext(pf, NULL, &ctx)) return 2;
    CGLSetCurrentContext(ctx);
    const char* vs = "void main() { gl_Position = gl_Vertex; }";
    const char* fs = "uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, vec2(0.5)); }";
    GLuint v=glCreateShader(GL_VERTEX_SHADER), f=glCreateShader(GL_FRAGMENT_SHADER), p=glCreateProgram();
    glShaderSource(v,1,&vs,NULL); glCompileShader(v); glShaderSource(f,1,&fs,NULL); glCompileShader(f);
    glAttachShader(p,v); glAttachShader(p,f); glLinkProgram(p); glUseProgram(p);
    GLint at=glGetUniformLocation(p,"tex"), max; glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS,&max);
    printf("{\n  \"renderer\":\"%s\",\n  \"maxCombined\":%d,\n  \"cases\":{", glGetString(GL_RENDERER),max);
    int values[] = {max-1,-1,max}; const char* names[] = {"last","negative","past_end"};
    for(int i=0;i<3;++i) {
        glUniform1i(at,values[i]); GLenum error=glGetError(); GLint value; glGetUniformiv(p,at,&value);
        printf("%s\n    \"%s\":[%u,%d]",i?",":"",names[i],error,value);
    }
    glUniform1i(-1,-1); printf(",\n    \"ignored\":[%u]\n  }\n}\n",glGetError());
    CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
