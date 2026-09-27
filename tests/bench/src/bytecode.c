// perlbench-like: a switch-dispatched stack-machine interpreter (indirect
// jump tables, unpredictable branches, small memory stack).
#include "../lib/bench.h"
enum { PUSH, LOAD, STORE, ADD, SUB, MUL, AND, XOR, SHL, SHR, LT, JZ, JMP, DUP, SWAP, DROP, INC, MOD, CALL, RET, HALT };
static const int program[] = {
    // for(i = 0; i < 2000; i++) { acc = (acc * 31 + i) ^ (i << 3); if(i % 7 < 3) acc += helper(i); }
    PUSH, 0, STORE, 0, PUSH, 7, STORE, 1,
    /* 8 loop */ LOAD, 0, PUSH, 2000, LT, JZ, 57,
    LOAD, 1, PUSH, 31, MUL, LOAD, 0, ADD, LOAD, 0, PUSH, 3, SHL, XOR, STORE, 1,
    LOAD, 0, PUSH, 7, MOD, PUSH, 3, LT, JZ, 50,
    LOAD, 1, LOAD, 0, CALL, 60, ADD, STORE, 1,
    /* 50 next */ LOAD, 0, INC, STORE, 0, JMP, 8,
    /* 57 end */ LOAD, 1, HALT,
    /* 60 helper(x) = (x ^ 0x5a5a) & 0xfff */ PUSH, 0x5a5a, XOR, PUSH, 0xfff, AND, RET,
};
NOINLINE static u32 run(const int *code)
{
    int stack[64], vars[4] = { 0 }, calls[16];
    int sp = 0, cp = 0, pc = 0;
    for(;;) {
        int op = code[pc++];
        switch(op) {
        case PUSH: stack[sp++] = code[pc++]; break;
        case LOAD: stack[sp++] = vars[code[pc++]]; break;
        case STORE: vars[code[pc++]] = stack[--sp]; break;
        case ADD: sp--; stack[sp - 1] += stack[sp]; break;
        case SUB: sp--; stack[sp - 1] -= stack[sp]; break;
        case MUL: sp--; stack[sp - 1] *= stack[sp]; break;
        case AND: sp--; stack[sp - 1] &= stack[sp]; break;
        case XOR: sp--; stack[sp - 1] ^= stack[sp]; break;
        case SHL: sp--; stack[sp - 1] <<= stack[sp]; break;
        case SHR: sp--; stack[sp - 1] = (u32)stack[sp - 1] >> stack[sp]; break;
        case LT: sp--; stack[sp - 1] = stack[sp - 1] < stack[sp]; break;
        case JZ: if(!stack[--sp]) pc = code[pc]; else pc++; break;
        case JMP: pc = code[pc]; break;
        case DUP: stack[sp] = stack[sp - 1]; sp++; break;
        case SWAP: { int t = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t; break; }
        case DROP: sp--; break;
        case INC: stack[sp - 1]++; break;
        case MOD: sp--; stack[sp - 1] %= stack[sp]; break;
        case CALL: calls[cp++] = pc + 1; pc = code[pc]; break;
        case RET: pc = calls[--cp]; break;
        case HALT: return stack[sp - 1];
        }
    }
}
u32 bench_main(u32 n)
{
    u32 h = 0x811C9DC5u;
    for(u32 i = 0; i < n; i++) h = mix(h, run(program));
    return h;
}
