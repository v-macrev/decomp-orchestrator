// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for tests: controlled mismatches. Each function is written in a spelling the engine's
// canonical form does not take, so that its first candidate compiles to code of one MISMATCH kind and a rule of the
// compiler knowledge base has to find the spelling. CountChain is a control no rule resolves yet:
// it must stay a MISMATCH of its kind. The engine is given the linked image and never this file.
struct Item { int value; int weight; Item* next; unsigned flags; };
extern int Work(int);
extern int Pair(int, int);
extern void Left(int);
extern void Right(int);

bool OneExit(const Item* n, int k)
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

int OneExitValue(const Item* n)
{
    int r = 0;
    if (n) {
        if (n->flags & 4)
            r = n->value;
        else
            r = n->weight;
    }
    return r;
}

int ArmsSwapped(Item* n, int k)
{
    if (n->value <= k)
        n->flags |= 2;
    else
        n->weight = k;
    return Work(k);
}

int Mirrored(int a, int b)
{
    if (b > a)
        return Work(a);
    return b;
}

int UnsignedShift(unsigned x, unsigned y) { return x < y ? Work(x >> 3) : 0; }

unsigned Remainder(unsigned x) { return x - static_cast<unsigned>((static_cast<unsigned long long>(x) * 0xCCCCCCCDull) >> 35) * 10; }

void ArmsTail(int x)
{
    if (x != 0)
        Right(x + 1);
    else
        Left(x);
}

int CountChain(Item* n)
{
    int c = 0;
    if (n->next && n->value) {
        do {
            n = n->next;
            ++c;
        } while (n->next && n->value);
    }
    return c;
}

int ShiftFirst(const Item* n, int k) { return k > n->value ? Pair(k, n->weight) : Work(n->value); }
