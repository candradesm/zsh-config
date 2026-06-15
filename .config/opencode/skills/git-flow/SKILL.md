---
name: git-flow
description: Load when creating commits, pull requests, or branches. Enforces commit message format, PR conventions (GitHub Issues), and branch naming. Never rebase or amend unless confirmed by the user.
---

## When to use me
- Creating a git commit
- Creating or drafting a pull request
- Creating a new branch

---

## Commits

Write a short, direct description in sentence case. Describe **what was done**, not which files changed. One line only.

✅ `Created /locale command to set locale of a guild`
✅ `Fixed crash when adding to basket`
❌ `Modified RemoteConfigProviderImpl.kt` — lists files
❌ `fix: apply formatting` — no type prefix needed

---

## Pull Requests

### Title
A short sentence describing what was done (past tense).

✅ `Created /locale command to set locale of a guild`
✅ `Fixed crash when adding to basket`
❌ `Modified files for locale` — vague, doesn't describe what was done

### Description
Follow the project's `.github/PULL_REQUEST_TEMPLATE.md`. Include:
- **Solves #issue** — link the issue(s) this PR closes
- **Changelist Summary** — one-liner of what was done
- **Description** — more detail about the implementation
- **Steps to reproduce** — only include if fixing a bug
- **Media** — include if visual changes
- **Extra info** — anything else relevant

Trim empty sections.

### AI-generated PR rules
- Open as **Draft**
- Append an auto-generated disclaimer at the bottom

---

## Branch naming

| Type | Format | Example |
|---|---|---|
| Feature | `feature/{issue}-kebab-desc` | `feature/60-command-to-set-locale` |
| Bug fix | `bugfix/{issue}-kebab-desc` | `bugfix/42-fix-crash` |
| Chore | `chore/{issue}-kebab-desc` | `chore/99-update-deps` |

- Use kebab-case
- Keep description short (3-6 words max)
- Always include the issue number from GitHub Issues

---

## Rebase & amend policy

- Never rebase or amend by default
- If the user requests a rebase, ask for confirmation first and warn about history rewriting
- Only proceed after the user confirms
