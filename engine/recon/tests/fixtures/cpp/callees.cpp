// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for tests. The functions the targets call, in an object of their own so that nothing is inlined.
struct Entry { int amount; Entry* next; float weight; };
struct Account { int id; int balance; unsigned flags; float rate; Account* parent; };

int Charge(Entry* entry, int amount)
{
    entry->amount = amount - 1;
    return entry->amount * 3;
}

void Notify(Account* account, int change)
{
    account->flags |= change < 0 ? 1u : 2u;
}

unsigned Mix(unsigned a, unsigned b)
{
    return a * 31u + (b ^ (a >> 3));
}

float Blend(float a, float b)
{
    return a * 0.25f + b;
}
