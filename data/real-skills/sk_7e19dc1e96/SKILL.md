---
id: sk_7e19dc1e96
name: Missing virtual slots shift every virtual call
description: Missing virtual slots shift every virtual call
version: 1
status: proposed
origin: repo_bootstrap
tokens: 74
triggers: {"features":{"minIndirectCalls":1},"patterns":["vtable"],"minScore":2.5}
# trigger: shape minIndirectCalls=1 · patterns vtable
---

**Missing virtual slots shift every virtual call.** (high confidence) A call through slot N needs N - 1 earlier virtuals in the stand-in, including the inherited TESForm slots; add placeholders labelled GUESS. Used for CanBeMoved (slot 0x42).
