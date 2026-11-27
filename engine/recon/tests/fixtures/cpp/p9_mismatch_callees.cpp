// SPDX-License-Identifier: AGPL-3.0-or-later
// Original synthetic code for tests: the callees of p9_mismatch.cpp.
int Work(int x) { return x * 3 + 1; }
int Pair(int a, int b) { return a - b; }
int g_side;
void Left(int x) { g_side = x; }
void Right(int x) { g_side = -x; }
