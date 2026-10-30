#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static int first=1;
static void start(const char* name){printf("%s{\"name\":\"%s\"",first?"":",\n",name);first=0;}
static void numbers(const double* p,int n){printf("[");for(int i=0;i<n;i++)printf("%s%.17g",i?",":"",p[i]);printf("]");}
static void map(const char* name,GLenum target,GLenum query,int n,int integer){
    double values[512]={0};GLint ints[512]={0};if(integer){glGetMapiv(target,query,ints);for(int i=0;i<n;i++)values[i]=ints[i];}else glGetMapdv(target,query,values);
    start(name);printf(",\"error\":%u,\"values\":",glGetError());numbers(values,n);printf("}");
}
static void error(const char* name){start(name);printf(",\"error\":%u}",glGetError());}
static GLfloat feedback[2048];
static void begin(GLenum type){for(int i=0;i<2048;i++)feedback[i]=-1234;glFeedbackBuffer(2048,type,feedback);glRenderMode(GL_FEEDBACK);}
static void end(const char* name){
    GLint count=glRenderMode(GL_RENDER);GLfloat color[4],normal[3],tex[4];glGetFloatv(GL_CURRENT_COLOR,color);glGetFloatv(GL_CURRENT_NORMAL,normal);glGetFloatv(GL_CURRENT_TEXTURE_COORDS,tex);
    start(name);printf(",\"error\":%u,\"count\":%d,\"values\":[",glGetError(),count);for(int i=0;i<count;i++)printf("%s%.9g",i?",":"",feedback[i]);
    printf("],\"current\":[");for(int i=0;i<4;i++)printf("%s%.9g",i?",":"",color[i]);for(int i=0;i<3;i++)printf(",%.9g",normal[i]);for(int i=0;i<4;i++)printf(",%.9g",tex[i]);GLfloat material[4];glGetMaterialfv(GL_FRONT,GL_DIFFUSE,material);printf("],\"material\":[%.9g,%.9g,%.9g,%.9g]}",material[0],material[1],material[2],material[3]);
}
static void reset(void){
    for(int i=0;i<9;i++){glDisable(GL_MAP1_COLOR_4+i);glDisable(GL_MAP2_COLOR_4+i);}glDisable(GL_AUTO_NORMAL);glDisable(GL_LIGHTING);glDisable(GL_LIGHT0);glDisable(GL_COLOR_MATERIAL);
    glColor4f(0.25,0.5,0.75,1);glNormal3f(0,0,0.25);glTexCoord4f(2,3,4,5);glActiveTexture(GL_TEXTURE0);glUseProgram(0);
}
static GLuint shader(void){
    const char* source="#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;gl_TexCoord[0]=vec4(gl_Normal,1);}";
    GLuint p=glCreateProgram(),v=glCreateShader(GL_VERTEX_SHADER);glShaderSource(v,1,&source,NULL);glCompileShader(v);glAttachShader(p,v);glLinkProgram(p);GLint ok;glGetProgramiv(p,GL_LINK_STATUS,&ok);if(!ok)return 0;glUseProgram(p);return p;
}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);glViewport(0,0,16,16);
    GLint maxOrder;glGetIntegerv(GL_MAX_EVAL_ORDER,&maxOrder);printf("{\"renderer\":\"%s\",\"maxEvalOrder\":%d,\"cases\":[\n",glGetString(GL_RENDERER),maxOrder);
    map("default_vertex3",GL_MAP1_VERTEX_3,GL_COEFF,3,0);map("default_vertex4",GL_MAP2_VERTEX_4,GL_COEFF,4,0);map("default_color",GL_MAP1_COLOR_4,GL_COEFF,4,0);map("default_normal",GL_MAP2_NORMAL,GL_COEFF,3,0);map("default_tex4",GL_MAP1_TEXTURE_COORD_4,GL_COEFF,4,0);map("default_index",GL_MAP2_INDEX,GL_COEFF,1,0);map("default_order1",GL_MAP1_VERTEX_3,GL_ORDER,1,0);map("default_order2",GL_MAP2_VERTEX_4,GL_ORDER,2,0);map("default_domain2",GL_MAP2_VERTEX_4,GL_DOMAIN,4,0);
    double curve[]={-0.5,0,0,99,0,1,0,99,0.5,0,0,99};glMap1d(GL_MAP1_VERTEX_3,-2,2,4,3,curve);map("strided_curve",GL_MAP1_VERTEX_3,GL_COEFF,9,0);map("curve_domain",GL_MAP1_VERTEX_3,GL_DOMAIN,2,0);
    double rounding[]={-1.5,-0.5,0.5,1.5};glMap1d(GL_MAP1_COLOR_4,0,1,4,1,rounding);map("integer_rounding",GL_MAP1_COLOR_4,GL_COEFF,4,1);
    reset();glEnable(GL_MAP1_VERTEX_3);begin(GL_4D_COLOR_TEXTURE);glBegin(GL_POINTS);glEvalCoord1d(0);glEvalCoord1d(3);glEnd();end("curve_evaluation");
    reset();glEvalCoord1d(0);error("outside_without_vertex_map");glEnable(GL_MAP1_VERTEX_3);glEvalCoord1d(0);error("outside_with_vertex_map");
    reset();double line[]={-0.5,-0.5,0,0.5,0.5,0};glMap1d(GL_MAP1_VERTEX_3,-2,2,3,2,line);glEnable(GL_MAP1_VERTEX_3);glMapGrid1d(2,-2,2);begin(GL_2D);glEvalMesh1(GL_POINT,-1,3);end("mesh1_points");begin(GL_2D);glEvalMesh1(GL_LINE,0,2);end("mesh1_lines");
    reset();double v3[]={-0.25,-0.375,0,-0.25,0.375,0,0.25,-0.375,0,0.25,0.375,0};glMap2d(GL_MAP2_VERTEX_3,0,1,6,2,0,1,3,2,v3);glEnable(GL_MAP2_VERTEX_3);glMapGrid2d(2,0,1,2,0,1);
    begin(GL_4D_COLOR_TEXTURE);glBegin(GL_POINTS);glEvalCoord2d(0.25,0.75);glEnd();end("surface_evaluation");
    begin(GL_2D);glEvalMesh2(GL_POINT,0,2,0,2);end("mesh2_points");begin(GL_2D);glEvalMesh2(GL_LINE,0,2,0,2);end("mesh2_lines");begin(GL_2D);glEvalMesh2(GL_FILL,0,1,0,1);end("mesh2_fill");
    double tex2[]={7,8},tex4[]={1,2,3,4},vertex4[]={0.25,0.5,0,2};glMap2d(GL_MAP2_TEXTURE_COORD_2,0,1,2,1,0,1,2,1,tex2);glMap2d(GL_MAP2_TEXTURE_COORD_4,0,1,4,1,0,1,4,1,tex4);glMap2d(GL_MAP2_VERTEX_4,0,1,4,1,0,1,4,1,vertex4);
    glEnable(GL_MAP2_TEXTURE_COORD_2);glEnable(GL_MAP2_TEXTURE_COORD_4);glEnable(GL_MAP2_VERTEX_4);begin(GL_4D_COLOR_TEXTURE);glBegin(GL_POINTS);glEvalCoord2d(0.5,0.5);glEnd();end("highest_dimension_precedence");
    glDisable(GL_MAP2_VERTEX_4);glDisable(GL_MAP2_TEXTURE_COORD_2);glDisable(GL_MAP2_TEXTURE_COORD_4);glEnable(GL_AUTO_NORMAL);GLuint p=shader();if(!p)return 3;
    begin(GL_4D_COLOR_TEXTURE);glBegin(GL_POINTS);glEvalCoord2d(0.5,0.5);glEnd();end("shader_auto_normal");
    double rational[]={-0.25,-0.375,0,1,-0.5,0.75,0,2,0.25,-0.375,0,1,0.5,0.75,0,2};glMap2d(GL_MAP2_VERTEX_4,0,1,8,2,0,1,4,2,rational);glEnable(GL_MAP2_VERTEX_4);
    begin(GL_4D_COLOR_TEXTURE);glBegin(GL_POINTS);glEvalCoord2d(0.5,0.5);glEnd();end("rational_auto_normal");glUseProgram(0);glDeleteProgram(p);
    reset();glEnable(GL_MAP2_VERTEX_3);glEnable(GL_AUTO_NORMAL);glEnable(GL_LIGHTING);glEnable(GL_LIGHT0);begin(GL_3D_COLOR);glBegin(GL_POINTS);glEvalCoord2d(0.5,0.5);glEnd();end("fixed_auto_normal");
    double mappedColor[]={0.6,0.2,0.1,1};glEnable(GL_COLOR_MATERIAL);glMap2d(GL_MAP2_COLOR_4,0,1,4,1,0,1,4,1,mappedColor);glEnable(GL_MAP2_COLOR_4);begin(GL_3D_COLOR);glBegin(GL_POINTS);glEvalCoord2d(0.5,0.5);glEnd();end("evaluated_color_material");
    reset();glMap1d(GL_MAP1_VERTEX_3,0,0,3,2,line);error("equal_map_domain");glMap1d(GL_MAP1_VERTEX_3,0,1,2,2,line);error("short_stride");glMap1d(GL_MAP1_VERTEX_3,0,1,3,0,line);error("zero_order");
    double big[27]={0};glMap1d(GL_MAP1_VERTEX_3,0,1,3,9,big);error("order_nine");glMapGrid1d(0,0,1);error("zero_grid");glMapGrid2d(2,0,1,-1,0,1);error("negative_grid");
    glActiveTexture(GL_TEXTURE1);glMap1d(GL_MAP1_VERTEX_3,0,1,3,2,line);error("nonzero_active_texture_map");map("nonzero_active_texture_get",GL_MAP1_VERTEX_3,GL_ORDER,1,0);glActiveTexture(GL_TEXTURE0);
    glBegin(GL_POINTS);glMapGrid1d(2,0,1);glEnd();error("grid_inside_begin");glBegin(GL_POINTS);glMap1d(GL_MAP1_VERTEX_3,0,1,3,2,line);glEnd();error("map_inside_begin");glBegin(GL_POINTS);glEvalMesh1(GL_POINT,0,1);glEnd();error("mesh_inside_begin");
    glMapGrid1d(3,-2,2);glPushAttrib(GL_EVAL_BIT);glMapGrid1d(5,-3,3);glMap1d(GL_MAP1_VERTEX_3,2,4,3,2,line);glEnable(GL_MAP1_VERTEX_3);glPopAttrib();map("map_not_restored_by_attrib",GL_MAP1_VERTEX_3,GL_DOMAIN,2,0);
    GLint segments;GLfloat domain[2];glGetIntegerv(GL_MAP1_GRID_SEGMENTS,&segments);glGetFloatv(GL_MAP1_GRID_DOMAIN,domain);start("grid_restored_by_attrib");printf(",\"error\":%u,\"values\":[%d,%.9g,%.9g,%u]}",glGetError(),segments,domain[0],domain[1],glIsEnabled(GL_MAP1_VERTEX_3));
    double frozen[]={-0.25,0,0,0.25,0,0};glNewList(1,GL_COMPILE);glMap1d(GL_MAP1_VERTEX_3,0,1,3,2,frozen);glEndList();frozen[0]=99;glCallList(1);map("list_frozen_map",GL_MAP1_VERTEX_3,GL_COEFF,6,0);
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
