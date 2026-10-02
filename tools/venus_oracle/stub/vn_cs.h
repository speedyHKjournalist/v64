/* stand-ins for the driver's command streams: enough for the generated code */
#ifndef VN_CS_H
#define VN_CS_H
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

struct vn_cs_encoder { uint8_t *base, *cur, *end; };
struct vn_cs_decoder { const uint8_t *cur, *end; bool fatal; };

static inline size_t vn_cs_encoder_get_len(const struct vn_cs_encoder *enc) { return enc->cur - enc->base; }
static inline bool vn_cs_encoder_reserve(struct vn_cs_encoder *enc, size_t size) { return enc->cur + size <= enc->end; }
static inline void vn_cs_encoder_write(struct vn_cs_encoder *enc, size_t size, const void *val, size_t val_size)
{
   if (enc->cur + size > enc->end) abort();
   memcpy(enc->cur, val, val_size);
   memset(enc->cur + val_size, 0, size - val_size);
   enc->cur += size;
}
static inline void vn_cs_decoder_set_fatal(struct vn_cs_decoder *dec) { dec->fatal = true; }
static inline bool vn_cs_decoder_peek_internal(const struct vn_cs_decoder *dec, size_t size, void *val, size_t val_size)
{
   if (dec->cur + size > dec->end) { memset(val, 0, val_size); return false; }
   memcpy(val, dec->cur, val_size);
   return true;
}
static inline void vn_cs_decoder_read(struct vn_cs_decoder *dec, size_t size, void *val, size_t val_size)
{
   if (vn_cs_decoder_peek_internal(dec, size, val, val_size)) dec->cur += size;
   else dec->fatal = true;
}
static inline void vn_cs_decoder_peek(const struct vn_cs_decoder *dec, size_t size, void *val, size_t val_size)
{
   vn_cs_decoder_peek_internal(dec, size, val, val_size);
}
/* handles are their ids here */
static inline uint64_t vn_cs_handle_load_id(const void **handle, VkObjectType type) { return (uint64_t)(uintptr_t)*handle; }
static inline void vn_cs_handle_store_id(void **handle, uint64_t id, VkObjectType type) { *handle = (void *)(uintptr_t)id; }
static inline bool vn_cs_renderer_protocol_has_extension(uint32_t ext) { return true; }
static inline bool vn_cs_renderer_protocol_has_api_version(uint32_t v) { return true; }
#endif
