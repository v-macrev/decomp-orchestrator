// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic callees of external.cpp, in a unit of their own so that the compiler cannot inline them.

int Scaled(int value)
{
    return value * 7 - 2;
}

unsigned int Mixed(unsigned int seed, int step)
{
    return (seed << step) | (seed >> (32 - step));
}
