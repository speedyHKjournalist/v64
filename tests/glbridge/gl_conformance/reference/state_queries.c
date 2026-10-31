#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void query(const char* name,GLenum pname,int count){
    GLdouble values[64]={0};glGetDoublev(pname,values);GLenum error=glGetError();
    printf("%s{\"name\":\"%s\",\"pname\":%u,\"error\":%u,\"values\":[",first?"":",\n",name,pname,error);first=0;
    for(int i=0;i<count;i++)printf("%s%.17g",i?",":"",values[i]);printf("]}");
}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    query("point_range",GL_POINT_SIZE_RANGE,2);query("point_granularity",GL_POINT_SIZE_GRANULARITY,1);
    query("line_range",GL_LINE_WIDTH_RANGE,2);query("aliased_line_range",GL_ALIASED_LINE_WIDTH_RANGE,2);
    query("max_attrib",GL_MAX_ATTRIB_STACK_DEPTH,1);query("max_client_attrib",GL_MAX_CLIENT_ATTRIB_STACK_DEPTH,1);
    query("max_color_matrix",GL_MAX_COLOR_MATRIX_STACK_DEPTH,1);query("rgba",GL_RGBA_MODE,1);query("stereo",GL_STEREO,1);
    query("attrib_initial",GL_ATTRIB_STACK_DEPTH,1);query("client_initial",GL_CLIENT_ATTRIB_STACK_DEPTH,1);
    glPushAttrib(GL_CURRENT_BIT);glPushAttrib(GL_COLOR_BUFFER_BIT);glPushClientAttrib(GL_CLIENT_VERTEX_ARRAY_BIT);
    query("attrib_pushed",GL_ATTRIB_STACK_DEPTH,1);query("client_pushed",GL_CLIENT_ATTRIB_STACK_DEPTH,1);
    glPopAttrib();glPopAttrib();glPopClientAttrib();query("attrib_popped",GL_ATTRIB_STACK_DEPTH,1);query("client_popped",GL_CLIENT_ATTRIB_STACK_DEPTH,1);
    query("arb_error_initial",GL_PROGRAM_ERROR_POSITION_ARB,1);GLint formats=0;glGetIntegerv(GL_NUM_COMPRESSED_TEXTURE_FORMATS,&formats);query("compressed_formats",GL_COMPRESSED_TEXTURE_FORMATS,formats);
    query("line_granularity",GL_LINE_WIDTH_GRANULARITY,1);query("aliased_point_range",GL_ALIASED_POINT_SIZE_RANGE,2);query("aux_buffers",GL_AUX_BUFFERS,1);
    query("index_mode",GL_INDEX_MODE,1);query("index_bits",GL_INDEX_BITS,1);query("accum_red",GL_ACCUM_RED_BITS,1);query("accum_green",GL_ACCUM_GREEN_BITS,1);query("accum_blue",GL_ACCUM_BLUE_BITS,1);query("accum_alpha",GL_ACCUM_ALPHA_BITS,1);
    GLfloat m[16];for(int i=0;i<16;i++)m[i]=i+1;glMatrixMode(GL_MODELVIEW);glLoadMatrixf(m);query("transpose_mv",GL_TRANSPOSE_MODELVIEW_MATRIX,16);
    for(int i=0;i<16;i++)m[i]=(i+1)*2;glMatrixMode(GL_PROJECTION);glLoadMatrixf(m);query("transpose_projection",GL_TRANSPOSE_PROJECTION_MATRIX,16);
    for(int i=0;i<16;i++)m[i]=i+2;glMatrixMode(GL_TEXTURE);glLoadMatrixf(m);query("transpose_tex0",GL_TRANSPOSE_TEXTURE_MATRIX,16);
    glActiveTexture(GL_TEXTURE3);for(int i=0;i<16;i++)m[i]=-i-0.5f;glLoadMatrixf(m);query("transpose_tex3",GL_TRANSPOSE_TEXTURE_MATRIX,16);
    glActiveTexture(GL_TEXTURE0);query("transpose_tex0_unchanged",GL_TRANSPOSE_TEXTURE_MATRIX,16);
    for(int i=0;i<16;i++)m[i]=i%5==0?i+1:0;glMatrixMode(GL_COLOR);glLoadMatrixf(m);query("transpose_color",GL_TRANSPOSE_COLOR_MATRIX,16);
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
