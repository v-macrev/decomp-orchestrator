// SPDX-License-Identifier: AGPL-3.0-or-later
// Written before the engine was run on any of it. Its first run (9 of 16) showed two defects of the engine, in Depth and Leftmost,
// which were corrected; nothing else was changed for these functions. docs/recon/IMPLEMENTATION_ROADMAP.md has both numbers.

struct Node {
    Node* left;
    Node* right;
    int key;
    short weight;
    unsigned char flags;
};

struct Table {
    Node** items;
    int count;
    float scale;
};

void Notify(Node* what, int amount);
int Mix(int a, int b);

int Depth(Node* node)
{
    if (!node)
        return 0;
    int left = Depth(node->left);
    int right = Depth(node->right);
    return (left > right ? left : right) + 1;
}

int SumRange(const int* values, int from, int to)
{
    int sum = 0;
    for (int i = from; i < to; ++i)
        sum += values[i];
    return sum;
}

int Grade(int points)
{
    if (points >= 90)
        return 1;
    else if (points >= 75)
        return 2;
    else if (points >= 50)
        return 3;
    return 4;
}

bool Contains(Table* table, int key)
{
    for (int i = 0; i < table->count; i++) {
        if (table->items[i]->key == key)
            return true;
    }
    return false;
}

void Mark(Node* node, unsigned char flag)
{
    if (node)
        node->flags |= flag;
}

int CountBits(unsigned value)
{
    int n = 0;
    while (value) {
        n += value & 1;
        value >>= 1;
    }
    return n;
}

float Average(const float* values, int count)
{
    if (count <= 0)
        return 0.0f;
    float sum = 0.0f;
    for (int i = 0; i < count; i++)
        sum += values[i];
    return sum / count;
}

int Combine(int a, int b, int c)
{
    int x = Mix(a, b);
    int y = Mix(b, c);
    return x * y + a;
}

void Update(Node* node, int amount)
{
    node->key += amount;
    node->weight = static_cast<short>(amount);
    if (node->key > 100)
        Notify(node, node->key - 100);
}

bool Between(float value, float low, float high)
{
    return value >= low && value <= high;
}

unsigned long long Pack(unsigned high, unsigned low)
{
    return (static_cast<unsigned long long>(high) << 32) | low;
}

Node* Leftmost(Node* node)
{
    if (!node)
        return nullptr;
    while (node->left)
        node = node->left;
    return node;
}

int Average2(int a, int b) { return (a + b) / 2; }

bool IsLeaf(const Node* node) { return !node->left && !node->right; }

void Scale(Table* table, float factor)
{
    table->scale *= factor;
    if (table->scale > 1.0f)
        table->scale = 1.0f;
}

int Gcd(int a, int b)
{
    while (b != 0) {
        int t = a % b;
        a = b;
        b = t;
    }
    return a;
}
