/*
 * Reference renderer for the GL pixel oracle: Apple's legacy OpenGL 2.1 via
 * CGL, no window. Every scene runs in a fresh context rendering into a 64x64
 * RGBA8 + DEPTH24_STENCIL8 FBO, then the pixels are dumped as JSON.
 *
 *   ./ref hw out.json      accelerated renderer (Metal-backed GLEngine)
 *   ./ref sw out.json      Apple Software Renderer (kCGLRendererGenericFloatID)
 */
#define GL_SILENCE_DEPRECATION 1
#define GL_GLEXT_PROTOTYPES 1
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SIZE 64
static GLuint g_fbo, g_rb_color, g_rb_ds;
static FILE* g_out;
static GLuint g_programs[64];
static GLuint g_cur_program;
static GLenum g_first_err;
static int g_first_err_op = -1;
static int g_extra_count;
static char g_log[8192];
static size_t g_log_len;

#define CHK(n) do { GLenum e_ = glGetError(); if (e_ && !g_first_err) { g_first_err = e_; g_first_err_op = (n); } } while (0)

static void logf_(const char* fmt, const char* a) {
    int n = snprintf(g_log + g_log_len, sizeof(g_log) - g_log_len, fmt, a);
    if (n > 0) g_log_len += (size_t)n;
    if (g_log_len >= sizeof(g_log)) g_log_len = sizeof(g_log) - 1;
}

static void bind_fb(GLuint name) { glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, name ? name : g_fbo); }

static void hex_out(const unsigned char* p, size_t n) {
    static const char* digits = "0123456789abcdef";
    fputc('"', g_out);
    for (size_t i = 0; i < n; ++i) { fputc(digits[p[i] >> 4], g_out); fputc(digits[p[i] & 15], g_out); }
    fputc('"', g_out);
}

static unsigned pixel_bytes(GLenum format, GLenum type) {
    unsigned comps;
    switch (type) {
    case GL_UNSIGNED_SHORT_5_6_5: case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_5_5_5_1: return 2;
    case GL_UNSIGNED_INT_8_8_8_8: case GL_UNSIGNED_INT_8_8_8_8_REV: return 4;
    }
    switch (format) {
    case GL_RGBA: case GL_BGRA: comps = 4; break;
    case GL_RGB: case GL_BGR: comps = 3; break;
    case GL_LUMINANCE_ALPHA: comps = 2; break;
    default: comps = 1; break;
    }
    switch (type) {
    case GL_UNSIGNED_SHORT: case GL_SHORT: return comps * 2;
    case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: return comps * 4;
    default: return comps;
    }
}

/* Same span formula as gl_pixel_span_with_state in opengl32_proxy.c. */
static void read_extra(GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type) {
    GLint align, row_length, skip_rows, skip_pixels;
    glGetIntegerv(GL_PACK_ALIGNMENT, &align);
    glGetIntegerv(GL_PACK_ROW_LENGTH, &row_length);
    glGetIntegerv(GL_PACK_SKIP_ROWS, &skip_rows);
    glGetIntegerv(GL_PACK_SKIP_PIXELS, &skip_pixels);
    unsigned bpp = pixel_bytes(format, type);
    unsigned row_pixels = row_length > 0 ? (unsigned)row_length : (unsigned)w;
    unsigned row_bytes = row_pixels * bpp;
    unsigned stride = (row_bytes + (unsigned)align - 1) / (unsigned)align * (unsigned)align;
    size_t total = (size_t)skip_rows * stride + (size_t)skip_pixels * bpp + (size_t)(h - 1) * stride + (size_t)w * bpp;
    unsigned char* buf = malloc(total);
    memset(buf, 0xCD, total);
    glReadPixels(x, y, w, h, format, type, buf);
    GLenum e = glGetError();
    if (e && !g_first_err) { g_first_err = e; g_first_err_op = 100000 + g_extra_count; }
    fprintf(g_out, "%s{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"format\":%u,\"type\":%u,\"error\":%u,\"bytes\":",
            g_extra_count ? "," : "", x, y, w, h, format, type, e);
    hex_out(buf, total);
    fputc('}', g_out);
    ++g_extra_count;
    free(buf);
}

static void make_program(int id, const char* vs_src, const char* fs_src) {
    GLuint p = glCreateProgram();
    const char* srcs[2] = { vs_src, fs_src };
    GLenum kinds[2] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    for (int i = 0; i < 2; ++i) {
        GLuint s = glCreateShader(kinds[i]);
        glShaderSource(s, 1, &srcs[i], NULL);
        glCompileShader(s);
        GLint ok; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
        if (!ok) { char log[1024]; glGetShaderInfoLog(s, sizeof log, NULL, log); logf_("compile failed: %s; ", log); }
        glAttachShader(p, s);
    }
    glLinkProgram(p);
    GLint ok; glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) { char log[1024]; glGetProgramInfoLog(p, sizeof log, NULL, log); logf_("link failed: %s; ", log); }
    g_programs[id] = p;
}

static void use_program(int id) { g_cur_program = id ? g_programs[id] : 0; glUseProgram(g_cur_program); }

static void arb_program(GLenum target, GLuint id, const char* text) {
    glBindProgramARB(target, id);
    glProgramStringARB(target, GL_PROGRAM_FORMAT_ASCII_ARB, (GLsizei)strlen(text), text);
    GLint pos; glGetIntegerv(GL_PROGRAM_ERROR_POSITION_ARB, &pos);
    if (pos != -1) {
        char msg[512];
        snprintf(msg, sizeof msg, "ARB program %u error at %d: %s; ", id, pos, (const char*)glGetString(GL_PROGRAM_ERROR_STRING_ARB));
        logf_("%s", msg);
    }
}

#include "scenes_gen.c"

static void json_str(const char* s) {
    fputc('"', g_out);
    for (; *s; ++s) {
        if (*s == '"' || *s == '\\') { fputc('\\', g_out); fputc(*s, g_out); }
        else if ((unsigned char)*s < 32) fprintf(g_out, "\\u%04x", *s);
        else fputc(*s, g_out);
    }
    fputc('"', g_out);
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s hw|sw out.json [scene-index]\n", argv[0]); return 2; }
    int sw = !strcmp(argv[1], "sw");
    int only = argc > 3 ? atoi(argv[3]) : -1;
    CGLPixelFormatAttribute attrs[24];
    int n = 0;
    attrs[n++] = kCGLPFAOpenGLProfile; attrs[n++] = (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy;
    attrs[n++] = kCGLPFAColorSize; attrs[n++] = (CGLPixelFormatAttribute)24;
    attrs[n++] = kCGLPFAAlphaSize; attrs[n++] = (CGLPixelFormatAttribute)8;
    attrs[n++] = kCGLPFADepthSize; attrs[n++] = (CGLPixelFormatAttribute)24;
    attrs[n++] = kCGLPFAStencilSize; attrs[n++] = (CGLPixelFormatAttribute)8;
    attrs[n++] = kCGLPFAAccumSize; attrs[n++] = (CGLPixelFormatAttribute)64;
    if (sw) { attrs[n++] = kCGLPFARendererID; attrs[n++] = (CGLPixelFormatAttribute)kCGLRendererGenericFloatID; }
    else attrs[n++] = kCGLPFAAccelerated;
    attrs[n] = 0;
    CGLPixelFormatObj pf; GLint npf;
    if (CGLChoosePixelFormat(attrs, &pf, &npf) || !pf) { fprintf(stderr, "no pixel format\n"); return 1; }
    g_out = fopen(argv[2], "w");
    int first = 1;
    for (int si = 0; si < SCENE_COUNT; ++si) {
        if (only >= 0 && si != only) continue;
        CGLContextObj ctx;
        if (CGLCreateContext(pf, NULL, &ctx)) { fprintf(stderr, "context failed\n"); return 1; }
        CGLSetCurrentContext(ctx);
        if (first) {
            fprintf(g_out, "{\"renderer\":");
            json_str((const char*)glGetString(GL_RENDERER));
            fprintf(g_out, ",\"version\":");
            json_str((const char*)glGetString(GL_VERSION));
            fprintf(g_out, ",\"enums\":{");
            for (size_t i = 0; i < sizeof(ENUMS) / sizeof(ENUMS[0]); ++i)
                fprintf(g_out, "%s\"%s\":%u", i ? "," : "", ENUMS[i].name, ENUMS[i].value);
            fprintf(g_out, "},\"scenes\":[\n");
        }
        glGenFramebuffersEXT(1, &g_fbo);
        glGenRenderbuffersEXT(1, &g_rb_color);
        glGenRenderbuffersEXT(1, &g_rb_ds);
        glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, g_fbo);
        glBindRenderbufferEXT(GL_RENDERBUFFER_EXT, g_rb_color);
        glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT, GL_RGBA8, SIZE, SIZE);
        glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_RENDERBUFFER_EXT, g_rb_color);
        glBindRenderbufferEXT(GL_RENDERBUFFER_EXT, g_rb_ds);
        glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT, GL_DEPTH24_STENCIL8_EXT, SIZE, SIZE);
        glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, g_rb_ds);
        glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT, GL_STENCIL_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, g_rb_ds);
        glBindRenderbufferEXT(GL_RENDERBUFFER_EXT, 0);
        GLenum status = glCheckFramebufferStatusEXT(GL_FRAMEBUFFER_EXT);
        /* prelude: identical on the executor side */
        glViewport(0, 0, SIZE, SIZE);
        glScissor(0, 0, SIZE, SIZE);
        glClearColor(0, 0, 0, 0);
        glClearDepth(1);
        glClearStencil(0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
        while (glGetError()) {}
        g_first_err = 0; g_first_err_op = -1; g_extra_count = 0; g_log_len = 0; g_log[0] = 0;
        g_cur_program = 0;
        fprintf(g_out, "%s{\"name\":\"%s\",\"fbo\":%u,\"extra\":[", first ? "" : ",\n", SCENE_NAMES[si], status);
        first = 0;
        SCENES[si]();
        /* epilogue: identical on the executor side */
        glUseProgram(0);
        bind_fb(0);
        glPixelStorei(GL_PACK_ALIGNMENT, 4);
        glPixelStorei(GL_PACK_ROW_LENGTH, 0);
        glPixelStorei(GL_PACK_SKIP_ROWS, 0);
        glPixelStorei(GL_PACK_SKIP_PIXELS, 0);
        unsigned char rgba[SIZE * SIZE * 4];
        memset(rgba, 0xCD, sizeof rgba);
        glReadPixels(0, 0, SIZE, SIZE, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
        GLenum e = glGetError();
        if (e && !g_first_err) { g_first_err = e; g_first_err_op = 200000; }
        fprintf(g_out, "],\"error\":%u,\"errorOp\":%d,\"log\":", g_first_err, g_first_err_op);
        json_str(g_log);
        fprintf(g_out, ",\"rgba\":");
        hex_out(rgba, sizeof rgba);
        fputc('}', g_out);
        CGLSetCurrentContext(NULL);
        CGLDestroyContext(ctx);
    }
    fprintf(g_out, "\n]}\n");
    fclose(g_out);
    return 0;
}
