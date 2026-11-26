// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic targets for measuring the execution check: narrow and wide results, calls whose results are
// dropped or kept, stores through pointers that may alias, so that alternatives the generator makes can disagree.

int Noted(int v);
long long Widened(int v);

struct Cell {
    int count;
    short tag;
    unsigned char flags;
};

short Narrow(int x)
{
    return static_cast<short>(x * 3);
}

unsigned char Low(unsigned int x)
{
    return static_cast<unsigned char>(x >> 4);
}

bool Even(int x)
{
    return (x & 1) == 0;
}

long long Wide(int x)
{
    return static_cast<long long>(x) * 5;
}

int Dropped(int x)
{
    Noted(x);
    return x + 1;
}

int Kept(int x)
{
    return Noted(x) - x;
}

long long Joined(int x, int y)
{
    return Widened(x) + y;
}

int Overlap(int* a, int* b)
{
    int first = *a;
    *b = first + 1;
    return first + *a;
}

void Bump(Cell* c, short tag)
{
    c->count += 1;
    c->tag = tag;
    c->flags |= 2;
}

int Signed(Cell* c)
{
    return c->tag < 0 ? -c->tag : c->tag;
}

unsigned int Tally(const unsigned char* p, int n)
{
    unsigned int sum = 0;
    for (int i = 0; i < n; ++i) {
        sum += p[i];
    }
    return sum;
}
