// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic callees of filtered.cpp, in a unit of their own so that the compiler cannot inline them.

static int g_seen;

int Noted(int v)
{
    g_seen += v;
    return g_seen;
}

long long Widened(int v)
{
    return static_cast<long long>(v) << 33;
}
