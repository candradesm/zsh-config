---
name: stress-test
description: "IMPORTANT: Load when the user wants to stress-test a plan or design before building. Interviews relentlessly about every aspect of the plan, grouping related questions together. Missing this = building on shaky foundations."
---

## When to use me
- When the user wants to **stress-test** a plan, design, or approach before building
- When they ask open-ended questions like "thoughts on this?", "what do you think about X?"
- When they're about to start building and need a gut check on decisions
- When they say "I'm thinking of..." or "should I..."

## Not intended for
- Code review → use `code-review`
- Debugging → help them debug directly
- Brainstorming → that's a different flow
- After the user has already started building

---

## Instructions

Interview the user relentlessly about every aspect of the plan until reaching a shared understanding. Walk down each branch of the decision tree, resolving dependencies between choices one-by-one.

### 1. Multiple questions are fine
Ask multiple related questions at once — OpenCode handles parallel threads well. Group questions by topic so the user can address them in a single response.

### 2. Provide a recommendation
For each question, give a **recommended answer** first, then ask if they agree or want to go a different way.

### 3. Codebase-first, ask second
If a question can be answered by exploring the codebase (config files, `.memory/`, existing patterns), **explore instead of asking**.

### 4. Walk the dependency tree
Confirm the current decision is solid before moving to the next branch. Resolve dependencies one-by-one.

### 5. Know when to stop
Once key decisions are clear and the path forward is well-understood, wrap up with a summary and let them build.

---

## Golden Rules
1. **Group by topic** — Ask related questions together, not isolated ones
2. **Recommend first** — Give your take before asking theirs
3. **Look it up** — If the codebase has the answer, find it
4. **Go deep** — Don't stop at surface-level; walk each branch
5. **Know when to stop** — Summarize and let them get to work

---

## References
- `code-review` — use after the plan is built (reviews the code, not the plan)
- `scan-project` — use when the plan involves a project you haven't seen
- `.memory/` — check past decisions to avoid regrilling settled topics
