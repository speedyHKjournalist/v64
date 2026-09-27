// mcf-like: pointer chasing through a randomly permuted 2 MiB list and a
// binary search tree (dependent loads, poor locality, TLB pressure).
#include "../lib/bench.h"
#define NODES (1 << 18)
struct node { struct node *next; u32 value; };
static struct node list[NODES];
struct tree { struct tree *left, *right; u32 key; };
static struct tree trees[1 << 14];
static u32 order[NODES];
NOINLINE static void build(void)
{
    u32 seed = 12345;
    for(u32 i = 0; i < NODES; i++) order[i] = i;
    for(u32 i = NODES - 1; i > 0; i--) {
        u32 j = lcg(&seed) % (i + 1), t = order[i];
        order[i] = order[j]; order[j] = t;
    }
    for(u32 i = 0; i < NODES; i++) {
        list[order[i]].next = &list[order[(i + 1) % NODES]];
        list[order[i]].value = i * 2654435761u;
    }
    struct tree *root = &trees[0];
    root->key = 0x80000000u; root->left = root->right = 0;
    for(u32 i = 1; i < (1 << 14); i++) {
        struct tree *t = &trees[i];
        t->key = lcg(&seed); t->left = t->right = 0;
        struct tree *p = root;
        for(;;) {
            struct tree **link = t->key < p->key ? &p->left : &p->right;
            if(!*link) { *link = t; break; }
            p = *link;
        }
    }
}
u32 bench_main(u32 n)
{
    build();
    u32 h = 0, seed = 99;
    struct node *p = &list[0];
    for(u32 i = 0; i < n; i++) {
        for(u32 k = 0; k < 4096; k++) { h += p->value; p = p->next; }
        for(u32 k = 0; k < 256; k++) {
            u32 key = lcg(&seed);
            struct tree *t = &trees[0];
            u32 depth = 0;
            while(t) { depth++; t = key < t->key ? t->left : t->right; }
            h = mix(h, depth);
        }
    }
    return h;
}
