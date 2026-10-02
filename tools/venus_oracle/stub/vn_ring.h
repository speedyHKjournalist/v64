#ifndef VN_RING_H
#define VN_RING_H
#include "vn_cs.h"
#define VN_TRACE_FUNC()
struct vn_ring;
struct vn_ring_submit_command { struct vn_cs_encoder command; size_t reply_size; struct vn_cs_decoder reply; uint32_t ring_seqno; bool ring_seqno_valid; };
static inline struct vn_cs_encoder *vn_ring_submit_command_init(struct vn_ring *ring, struct vn_ring_submit_command *submit, void *data, size_t size, size_t reply_size) { abort(); }
static inline void vn_ring_submit_command(struct vn_ring *ring, struct vn_ring_submit_command *submit) { abort(); }
static inline struct vn_cs_decoder *vn_ring_get_command_reply(struct vn_ring *ring, struct vn_ring_submit_command *submit) { abort(); }
static inline void vn_ring_free_command_reply(struct vn_ring *ring, struct vn_ring_submit_command *submit) { }
#endif
