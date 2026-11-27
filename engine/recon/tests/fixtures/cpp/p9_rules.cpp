// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for the compiler knowledge base (core/synthesis/rules.py): pairs of spellings of one
// function, before and after one rule's transformation. Positive pairs must compile differently, in a kind the rule
// claims; negative pairs (Neg) are where the rule's precondition fails and must compile identically.
struct P9Node { int value; int weight; P9Node* next; unsigned flags; };
extern int P9Work(int);
extern int P9Pair(int, int);
extern void P9Left(int);
extern void P9Right(int);
extern int P9Narrow(signed char);
extern int P9Wide(int);

// ---- exit arrangement: early returns against one result local and one return (cookbook 34)
bool ExitBefore(const P9Node* n, int k)
{
    if (!n)
        return false;
    if (n->value == k)
        return true;
    return n->weight == k;
}
bool ExitAfter(const P9Node* n, int k)
{
    bool result = false;
    if (n) {
        if (n->value == k)
            result = true;
        else
            result = n->weight == k;
    }
    return result;
}
int ExitNegBefore(int x) { return P9Work(x); }
int ExitNegAfter(int x) { int result = P9Work(x); return result; }

// ---- select form: a conditional value as ?: against statements
int SelectBefore(int c, int a, int b) { return P9Work(c ? a : b); }
int SelectAfter(int c, int a, int b)
{
    int v;
    if (c)
        v = a;
    else
        v = b;
    return P9Work(v);
}
int SelectNegBefore(int c) { return c ? 7 : 7; }
int SelectNegAfter(int c) { int v; if (c) v = 7; else v = 7; return v; }

// ---- loop form: a for loop against the guarded do-while the compiler makes of it
int LoopBefore(const P9Node* n, int k)
{
    while (n && n->value != k)
        n = n->next;
    return n ? n->weight : 0;
}
int LoopAfter(const P9Node* n, int k)
{
    if (n && n->value != k) {
        do
            n = n->next;
        while (n && n->value != k);
    }
    return n ? n->weight : 0;
}
int LoopNegBefore(int x) { return x + 1; }
int LoopNegAfter(int x) { return x + 1; }

// ---- arms exchanged: a two-way branch written with its condition negated and its arms swapped
void ArmsBefore(int x)
{
    if (x == 0)
        P9Left(x);
    else
        P9Right(x + 1);
}
void ArmsAfter(int x)
{
    if (x != 0)
        P9Right(x + 1);
    else
        P9Left(x);
}
void ArmsNegBefore(int x) { P9Left(x); }
void ArmsNegAfter(int x) { P9Left(x); }

// ---- comparison mirrored: a < b written as b > a
int MirrorBefore(int a, int b)
{
    if (a < b)
        return P9Work(a);
    return b;
}
int MirrorAfter(int a, int b)
{
    if (b > a)
        return P9Work(a);
    return b;
}
int MirrorNegBefore(int a) { return P9Work(a); }
int MirrorNegAfter(int a) { return P9Work(a); }

// ---- read again: a member read once into a local, against read again where it is used (cookbook 1)
int ReadBefore(P9Node* n)
{
    int v = n->value;
    P9Work(v);
    return v + n->weight;
}
int ReadAfter(P9Node* n)
{
    P9Work(n->value);
    return n->value + n->weight;
}
int ReadNegBefore(const P9Node* n) { int v = n->value; return v + n->weight; }
int ReadNegAfter(const P9Node* n) { return n->value + n->weight; }

// ---- sign: an integer whose sign nothing else decides, declared signed against unsigned (cookbook 38)
int SignBefore(int x, int y) { return x < y ? P9Work(x >> 3) : 0; }
int SignAfter(unsigned x, unsigned y) { return x < y ? P9Work(x >> 3) : 0; }
int SignNegBefore(int x) { return P9Work(x & 15); }
int SignNegAfter(unsigned x) { return P9Work(x & 15); }

// ---- arithmetic undo: a division against the multiply-and-shift the compiler makes of it
unsigned UndoBefore(unsigned x) { return x / 10; }
unsigned UndoAfter(unsigned x) { return static_cast<unsigned>((static_cast<unsigned long long>(x) * 0xCCCCCCCDull) >> 35); }
unsigned UndoNegBefore(unsigned x) { return x + 10; }
unsigned UndoNegAfter(unsigned x) { return x + 10; }

// ---- result reading: the result as a truth value against a full integer (cookbook 66)
bool ResultBefore(const P9Node* n) { return n->flags > 3; }
int ResultAfter(const P9Node* n) { return n->flags > 3; }
int ResultNegBefore(const P9Node* n) { return n->value; }
int ResultNegAfter(const P9Node* n) { return n->value; }

// ---- callee reading: a callee's parameter read at another width (cookbook D, 68)
int CalleeBefore(int x) { return P9Wide(static_cast<signed char>(x)); }
int CalleeAfter(int x) { return P9Narrow(static_cast<signed char>(x)); }
int CalleeNegBefore(int x) { return P9Wide(x); }
int CalleeNegAfter(int x) { return P9Wide(x); }

// ---- second positive cases, and more negative ones
extern int P9Unsigned(unsigned char);
int Exit2Before(const P9Node* n) { if (!n) return 0; if (n->flags & 4) return n->value; return n->weight; }
int Exit2After(const P9Node* n) { int r = 0; if (n) { if (n->flags & 4) r = n->value; else r = n->weight; } return r; }
unsigned Select2Before(unsigned x, unsigned lim) { unsigned v = x > lim ? lim : x; return v * 3; }
unsigned Select2After(unsigned x, unsigned lim) { unsigned v; if (x > lim) v = lim; else v = x; return v * 3; }
int Loop2Before(const int* p, int k) { while (*p != k && *p) ++p; return *p; }
int Loop2After(const int* p, int k) { if (*p != k && *p) { do ++p; while (*p != k && *p); } return *p; }
int Arms2Before(int x) { int r; if (x == 0) r = P9Work(x); else r = P9Pair(x, 1); return r + 1; }
int Arms2After(int x) { int r; if (x != 0) r = P9Pair(x, 1); else r = P9Work(x); return r + 1; }
int Arms3Before(P9Node* n, int k) { if (n->value > k) n->weight = k; else n->flags |= 2; return P9Work(k); }
int Arms3After(P9Node* n, int k) { if (n->value <= k) n->flags |= 2; else n->weight = k; return P9Work(k); }
int Mirror2Before(unsigned a, unsigned b) { if (a <= b) return P9Work(1); return 0; }
int Mirror2After(unsigned a, unsigned b) { if (b >= a) return P9Work(1); return 0; }
int Read2Before(P9Node* n) { unsigned f = n->flags; P9Work(1); return f & 3 ? P9Work(2) : 0; }
int Read2After(P9Node* n) { P9Work(1); return n->flags & 3 ? P9Work(2) : 0; }
// no call or store that may change the member between the reads: the compiler reads it once either way
int ReadNeg2Before(P9Node* n) { int v = n->value; n->weight = v; return P9Work(v); }
int ReadNeg2After(P9Node* n) { n->weight = n->value; return P9Work(n->value); }
int Sign2Before(int x, int y) { if (x < y) return P9Work(x); return 0; }
int Sign2After(unsigned x, unsigned y) { if (x < y) return P9Work(x); return 0; }
int Undo2Before(int x) { return x / 7; }
int Undo2After(int x) { long long p = static_cast<long long>(x) * 0x92492493LL; int q = static_cast<int>(p >> 32) + x; q >>= 2; return q - (q >> 31); }
unsigned Undo3Before(unsigned x) { return x % 10; }
unsigned Undo3After(unsigned x) { return x - static_cast<unsigned>((static_cast<unsigned long long>(x) * 0xCCCCCCCDull) >> 35) * 10; }
bool Result2Before(int a, int b) { return a == b; }
int Result2After(int a, int b) { return a == b; }
int Callee2Before(int x) { return P9Wide(static_cast<unsigned char>(x)); }
int Callee2After(int x) { return P9Unsigned(static_cast<unsigned char>(x)); }
