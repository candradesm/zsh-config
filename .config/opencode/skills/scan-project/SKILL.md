---
name: scan-project
description: "IMPORTANT: Load when starting work on a project you haven't seen before. Scans the local workspace to understand project structure, tech stack, and existing documentation. Creates a memory bank in .memory/ for future sessions."
---

## When to use me
- First time working on a project
- After a long break from a project
- When `.memory/` doesn't exist or is stale

## Not intended for
- Creating docs/skills from scratch → use `bootstrapper`
- Day-to-day coding → use project-specific skills
- Code review → use `code-review`

---

## Phase 0 — Check Memory Bank

```bash
ls -la .memory/
```

If `.memory/` exists and has recent files, read them first:
- `.memory/STATUS.md` — current project state
- `.memory/summary.md` — project overview

If `.memory/` doesn't exist → proceed to Phase 1.

---

## Phase 1 — Scan Project Structure

### Detect Tech Stack

```bash
# Build files
ls build.gradle.kts package.json Cargo.toml go.mod pom.xml pyproject.toml 2>/dev/null

# Source structure
ls src/ lib/ app/ 2>/dev/null

# Config files
ls .github/ .editorconfig ktlint* eslint* 2>/dev/null
```

### Read Key Files

Read (only what's needed):
1. Build file — language, dependencies, commands
2. README.md — project description
3. `.github/copilot-instructions.md` — existing instructions
4. `.github/instructions/` — topic-specific guidance

---

## Phase 2 — Create Memory Bank

Create `.memory/` directory with:

### File 1: `summary.md`

```markdown
# Project Summary

## What is this?
{one paragraph description}

## Tech Stack
- **Language**: {language} {version}
- **Build**: {build_tool}
- **Framework**: {main_framework}
- **Architecture**: {arch_pattern}

## Key Commands
- Build: `{command}`
- Test: `{command}`
- Lint: `{command}`

## Source Structure
{directory_tree}
```

### File 2: `STATUS.md`

```markdown
# Project Status

## Current State
- Last scanned: {date}
- Tests: {passing/failing count}
- Build: {working/broken}

## Active Work
- {any current issues or PRs}

## Notes
- {any important observations}
```

---

## Phase 3 — Report

Report to user:
1. What was found (tech stack, structure)
2. What was created (memory bank files)
3. What skills are available (`.agents/skills/`)
4. Any issues detected (failing tests, missing config)

### Skill Cross-References

When reporting available skills, include their click-baity descriptions so the agent knows when to lazy-load them:

- `code-quality` — **CRITICAL**: Load for ALL code changes. Violations = failing CI.
- `quality-check` — **CRITICAL**: Load BEFORE opening any PR.
- `testing` — **IMPORTANT**: Load when writing tests or debugging.
- `architecture` — **IMPORTANT**: Load when adding new commands/services.
- `dependencies` — **IMPORTANT**: Load when adding/updating dependencies.
- `discord-integration` — **CRITICAL**: Load when adding new Discord commands.

---

## Golden Rules

1. **Don't overwrite** — If `.memory/` has recent files, read first
2. **Be minimal** — Only read what's needed, don't dump entire codebase
3. **Stay fresh** — Re-scan if project has changed significantly
4. **Report clearly** — User should understand project state in 30 seconds

---

## References
- `.memory/STATUS.md` — project state tracking
- `.github/copilot-instructions.md` — project overview
- `bootstrapper` — for creating docs/skills from scratch
