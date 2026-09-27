// omnetpp-like: discrete event simulation with a binary-heap event queue and
// virtual dispatch through vtables (indirect calls, pointer-heavy structs).
#include "../lib/bench.h"
struct module;
struct vtable { u32 (*handle)(struct module *, u32 time); u32 (*delay)(struct module *); };
struct module { const struct vtable *vt; u32 state, count, id; };
struct event { u32 time; struct module *target; };
static struct event heap[4096];
static u32 heap_size;
static struct module modules[64];
static void push(u32 time, struct module *m)
{
    u32 i = heap_size++;
    while(i && heap[(i - 1) / 2].time > time) { heap[i] = heap[(i - 1) / 2]; i = (i - 1) / 2; }
    heap[i].time = time; heap[i].target = m;
}
static struct event pop(void)
{
    struct event top = heap[0], last = heap[--heap_size];
    u32 i = 0;
    for(;;) {
        u32 c = 2 * i + 1;
        if(c >= heap_size) break;
        if(c + 1 < heap_size && heap[c + 1].time < heap[c].time) c++;
        if(heap[c].time >= last.time) break;
        heap[i] = heap[c]; i = c;
    }
    heap[i] = last;
    return top;
}
static u32 queue_handle(struct module *m, u32 t) { m->state = m->state * 3 + t; return ++m->count; }
static u32 queue_delay(struct module *m) { return 5 + (m->state & 15); }
static u32 router_handle(struct module *m, u32 t) { m->state ^= t << (m->id & 7); return m->count += 2; }
static u32 router_delay(struct module *m) { return 3 + (m->state >> 28); }
static u32 sink_handle(struct module *m, u32 t) { m->state += t; return m->count; }
static u32 sink_delay(struct module *m) { return 11 + (m->id & 3); }
static const struct vtable vtables[3] = {
    { queue_handle, queue_delay }, { router_handle, router_delay }, { sink_handle, sink_delay },
};
u32 bench_main(u32 n)
{
    for(u32 i = 0; i < 64; i++) { modules[i].vt = &vtables[i % 3]; modules[i].state = i; modules[i].count = 0; modules[i].id = i; }
    heap_size = 0;
    for(u32 i = 0; i < 1024; i++) push(i * 7 % 1000, &modules[i & 63]);
    u32 h = 0;
    for(u32 i = 0; i < n * 1024; i++) {
        struct event e = pop();
        struct module *m = e.target;
        h = mix(h, m->vt->handle(m, e.time));
        struct module *next = &modules[(m->state + i) & 63];
        push(e.time + m->vt->delay(m), next);
    }
    return h;
}
