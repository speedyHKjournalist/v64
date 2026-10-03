#version 450
// the texture, a separate sampler; a specialization constant scales
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 out_color;
layout(set = 0, binding = 0) uniform texture2D tex;
layout(set = 0, binding = 1) uniform sampler smp;
layout(constant_id = 7) const float brightness = 1.0;
void main() {
    out_color = texture(sampler2D(tex, smp), v_uv) * brightness;
}
