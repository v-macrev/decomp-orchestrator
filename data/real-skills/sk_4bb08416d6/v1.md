---
id: sk_4bb08416d6
name: Register differences in a switch: change the width of the switch operand
description: Register differences in a switch: change the width of the switch operand
version: 1
status: proposed
origin: repo_bootstrap
tokens: 86
triggers: {"features":{"minIndirectJumps":1},"patterns":["switch"],"minScore":2.5}
# trigger: shape minIndirectJumps=1 · patterns switch
---

**Register differences in a switch: change the width of the switch operand.** (medium confidence) `switch (static_cast<std::uint32_t>(byteField))` and switching on a byte enum give different register allocation and different zero-extension placement. Try both. Closed VisitWornItems.
