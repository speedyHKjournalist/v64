#version 450
// position (x, y, z) and color from vertex buffers; push constants move
// and scale; a uniform buffer tints
layout(location = 0) in vec3 position;
layout(location = 1) in vec4 color;
layout(location = 0) out vec4 v_color;
layout(push_constant) uniform Push { vec2 offset; float scale; float pad; } pc;
layout(set = 0, binding = 0) uniform Frame { vec4 tint; } frame;
void main() {
    v_color = color * frame.tint;
    gl_Position = vec4(position.xy * pc.scale + pc.offset, position.z, 1.0);
}
