// xalancbmk-like: tokenizing text, hashing words into a chained table, string
// comparisons and byte loops.
#include "../lib/bench.h"
static char text[65536];
struct entry { const char *word; u32 length, count; struct entry *next; };
static struct entry entries[8192];
static struct entry *buckets[1024];
static const char *const words[] = { "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "element", "attribute", "namespace", "document", "stylesheet", "template", "select", "value" };
NOINLINE static void make_text(void)
{
    u32 seed = 7, at = 0;
    while(at < sizeof(text) - 16) {
        const char *w = words[lcg(&seed) >> 28];
        while(*w) text[at++] = *w++;
        text[at++] = (lcg(&seed) >> 29) ? ' ' : '\n';
    }
    text[at] = 0;
}
static int compare(const char *a, const char *b, u32 n)
{
    for(u32 i = 0; i < n; i++) if(a[i] != b[i]) return a[i] - b[i];
    return 0;
}
NOINLINE static u32 index_text(void)
{
    u32 used = 0;
    memset(buckets, 0, sizeof(buckets));
    for(const char *p = text; *p;) {
        while(*p == ' ' || *p == '\n') p++;
        const char *start = p;
        u32 h = 2166136261u;
        while(*p && *p != ' ' && *p != '\n') h = (h ^ (u8)*p++) * 16777619u;
        u32 len = p - start;
        if(!len) break;
        struct entry **b = &buckets[h & 1023], *e = *b;
        while(e && (e->length != len || compare(e->word, start, len))) e = e->next;
        if(e) e->count++;
        else if(used < 8192) { e = &entries[used++]; e->word = start; e->length = len; e->count = 1; e->next = *b; *b = e; }
    }
    u32 h = 0;
    for(u32 i = 0; i < used; i++) h = mix(h, entries[i].count * entries[i].length);
    return h;
}
u32 bench_main(u32 n)
{
    make_text();
    u32 h = 0;
    for(u32 i = 0; i < n; i++) { h = mix(h, index_text()); text[i % 60000] ^= 1; }
    return h;
}
