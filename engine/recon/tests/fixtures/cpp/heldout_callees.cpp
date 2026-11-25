// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for tests: what the held-out functions call.
struct Node { Node* left; Node* right; int key; short weight; unsigned char flags; };

void Notify(Node* what, int amount)
{
    what->key = amount < 0 ? 0 : amount;
}

int Mix(int a, int b)
{
    return (a ^ b) * 17;
}
