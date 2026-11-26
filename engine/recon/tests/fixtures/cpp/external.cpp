// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic targets: functions that call functions of another unit, known to them only by declaration.

int Scaled(int value);
unsigned int Mixed(unsigned int seed, int step);

int Halved(int x)
{
    return Scaled(x) / 2;
}

int Offset(int x, int y)
{
    return Scaled(x + y) + 7;
}

unsigned int Stir(unsigned int s)
{
    return Mixed(s, 3) ^ s;
}
