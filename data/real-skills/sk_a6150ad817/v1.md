---
id: sk_a6150ad817
name: A flag bit tested as load, `shr`, `test al,1`: a by-value bit-index helper
description: the target reads a flag word into a register, shifts it right by the bit number and tests the low byte (`mov eax,[rcx+0x10]; shr eax,3; test al,1`); the candidate has `test byte ptr [mem],imm`, `test dword ptr [mem],imm` or `bt`.
version: 1
status: proposed
origin: repo_bootstrap
tokens: 309
triggers: {"mnemonics":["\\btest\\s+al\\s*,\\s*(?:0x)?[0-9a-f]+h?","\\bshr\\s+eax\\s*,\\s*(?:0x)?[0-9a-f]+h?","\\bmovzx\\s+eax\\s*,\\s*(?:byte|word|dword|qword) ptr ?\\[[^\\]]*\\]","\\band\\s+al\\s*,\\s*(?:0x)?[0-9a-f]+h?"],"minScore":3}
# trigger: listing ~ /\btest\s+al\s*,\s*(?:0x)?[0-9a-f]+h?/ | /\bshr\s+eax\s*,\s*(?:0x)?[0-9a-f]+h?/ | /\bmovzx\s+eax\s*,\s*(?:byte|word|dword|qword) ptr ?\[[^\]]*\]/ | /\band\s+al\s*,\s*(?:0x)?[0-9a-f]+h?/
---

**A flag bit tested as load, `shr`, `test al,1`: a by-value bit-index helper.** (high confidence) Symptom: the target reads a flag word into a register, shifts it right by the bit number and tests the low byte (`mov eax,[rcx+0x10]; shr eax,3; test al,1`); the candidate has `test byte ptr [mem],imm`, `test dword ptr [mem],imm` or `bt`. Cause: MSVC folds every mask, bit-field or direct `(flags >> n) & 1` spelling of the member into a memory test; the shift survives only when the word and the bit number reach the test through an inlined call. Fix, first thing to try:

```cpp
// TestBit: GUESS(low); a flag-word bit test by bit index, taking the word by value.
inline bool TestBit(std::uint32_t a_flags, std::uint32_t a_bit)
{
    return ((a_flags >> a_bit) & 1) != 0;
}
... if (TestBit(formFlags, 3)) ...
```

For a bit-field struct, pass the whole word (`*reinterpret_cast<const std::uint32_t*>(&flags)` in a small accessor). The label is `GUESS(low)`: the helper's name and the engine's real accessor are unknown.
