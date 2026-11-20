---
id: sk_c42dd717e8
name: A vtable slot 0 destructor is the deleting destructor, `??_G` (or `??_E`), not `??1`
description: `function-size-mismatch` on `X::~X`, the target larger than the candidate, its listing testing bit 0 of the second argument and calling operator delete under it.
version: 1
status: proposed
origin: repo_bootstrap
tokens: 194
triggers: {"features":{"minIndirectCalls":1,"destructor":true},"patterns":["vtable"],"failures":["function-size-mismatch"],"minScore":2.5}
# trigger: shape minIndirectCalls=1, destructor=true · patterns vtable · after function-size-mismatch
---

**A vtable slot 0 destructor is the deleting destructor, `??_G` (or `??_E`), not `??1`.** (high confidence) Symptom: `function-size-mismatch` on `X::~X`, the target larger than the candidate, its listing testing bit 0 of the second argument and calling operator delete under it. The compiler always emits the plain `??1` separately; the slot body is `??_G` with the destructor inlined, emitted only beside the vftable, so the unit must define a constructor (or otherwise reference the vftable). `attempt` reads the kind from the pack (`task.json` `functions[].destructor`) and binds it; a bind hint it cannot use is printed as a WARNING.
