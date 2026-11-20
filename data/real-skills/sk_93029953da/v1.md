---
id: sk_93029953da
name: A dead loop or a redundant test in a loop: an inlined helper was called twice
description: the target has a loop that is not rotated, a computed value that is never used, and a null test that repeats.
version: 1
status: proposed
origin: repo_bootstrap
tokens: 124
triggers: {"features":{"minLoops":1},"patterns":["loop"],"minScore":2.5}
# trigger: shape minLoops=1 · patterns loop
---

**A dead loop or a redundant test in a loop: an inlined helper was called twice.** (medium confidence) Symptom: the target has a loop that is not rotated, a computed value that is never used, and a null test that repeats. Cause: a null-checking helper is called in both the loop condition and the body: `while (Root(p->parent)) p = Root(p->parent);`. Fix: write it that way rather than with one cached call.
