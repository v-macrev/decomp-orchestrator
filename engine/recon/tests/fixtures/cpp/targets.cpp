// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for tests. The engine is given the linked image and never this file.
struct Entry { int amount; Entry* next; float weight; };
struct Account { int id; int balance; unsigned flags; float rate; Account* parent; };
extern int Charge(Entry* entry, int amount);
extern void Notify(Account* account, int change);
extern unsigned Mix(unsigned a, unsigned b);
extern float Blend(float a, float b);

int Constant() { return 1234; }

int Clamp(int value, int low, int high)
{
    if (value < low)
        return low;
    if (value > high)
        return high;
    return value;
}

unsigned Digits(unsigned value)
{
    return value / 10 + value % 10;
}

int Quotient(int value) { return value / 7; }

int Length(const char* text)
{
    int n = 0;
    while (text[n])
        ++n;
    return n;
}

// a loop, branches, member accesses and a call
int Total(Entry* head, int limit)
{
    int total = 0;
    for (Entry* e = head; e; e = e->next) {
        if (e->amount > limit)
            total += Charge(e, e->amount);
        else
            total += e->amount;
    }
    return total;
}

bool Withdraw(Account* account, int amount)
{
    if (!account || amount <= 0)
        return false;
    if (account->balance < amount) {
        account->flags |= 8;
        return false;
    }
    account->balance -= amount;
    Notify(account, -amount);
    return true;
}

Account* Root(Account* account)
{
    while (account->parent)
        account = account->parent;
    return account;
}

Entry* Find(Entry* head, int amount)
{
    for (; head; head = head->next)
        if (head->amount == amount)
            return head;
    return nullptr;
}

void Reset(Account* account)
{
    account->balance = 0;
    account->flags = 0;
    account->rate = 1.5f;
    account->parent = nullptr;
}

unsigned Hash(unsigned seed, unsigned count)
{
    for (unsigned i = 0; i < count; ++i)
        seed = Mix(seed, i);
    return seed;
}

float Weigh(Account* account, float scale)
{
    if (account->rate > scale)
        return account->rate * scale;
    return Blend(account->rate, scale) + 2.0f;
}

unsigned Forward(unsigned a) { return Mix(a, 7); }

void Swap(int* a, int* b)
{
    int t = *a;
    *a = *b;
    *b = t;
}

int Sign(int value)
{
    if (value > 0)
        return 1;
    if (value < 0)
        return -1;
    return 0;
}

int Select(Account* account, int other)
{
    return account->flags & 4 ? account->balance : other;
}

long long Scaled(Account* account, long long factor)
{
    return account->balance * factor + account->id;
}

void Promote(Account* account, int steps)
{
    int old = account->balance;
    account->balance = old + steps * 5;
    if (account->balance != old && account->parent)
        Notify(account->parent, account->balance - old);
    account->id++;
}
