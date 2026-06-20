---
name: create-skill
description: "CRITICAL: Load when creating a new skill in .config/opencode/skills/. Enforces directory structure, frontmatter format, section conventions, and description click-bait rules. Missing this = inconsistent skills that confuse agents."
---

## When to use me
- Creating a brand new skill in `.config/opencode/skills/`
- Reviewing whether an existing skill follows repo conventions
- Understanding the skill file format and rules

## Not intended for
- Bootstrapping skills for other repos → use `bootstrapper`
- Updating existing skills → read them first, ask user what to change
- Day-to-day coding → use project-specific skills

---

## Skill file structure

Location depends on where the skill lives:

| Context | Path |
|---------|------|
| **Global** (user's machine) | `~/.config/opencode/skills/{skill-name}/SKILL.md` |
| **Inside a repo** | `.agents/skills/{skill-name}/SKILL.md` |

The directory name and the `name` field in frontmatter must match (kebab-case).

---

## Template

Every skill MUST follow this format:

```markdown
---
name: skill-name
description: "{CRITICAL/IMPORTANT}: Load when {trigger}. {What it covers}. {Consequence of not loading}."
---

## When to use me
- {trigger_1}
- {trigger_2}

## Not intended for
- {non_use_1} → use `{other_skill}`

---

{actionable content — commands, checklists, tables, code blocks}

---

## References
- `{other-skill}` — cross-reference related skills
- {project files or external docs as needed}
```

---

## Frontmatter rules

### `name`
- Kebab-case, matches directory name
- Single, descriptive word or compound: `code-review`, `create-issue`, `scan-project`

### `description`
- Must be a single paragraph, not multiple lines
- Start with `CRITICAL:` or `IMPORTANT:` based on consequence severity:

| Prefix | When to use |
|--------|-------------|
| `CRITICAL:` | Missing this causes failures (broken CI, runtime crashes, rejected PRs) |
| `IMPORTANT:` | Missing this causes quality issues or onboarding confusion |
| *(none)* | Optional but helpful context |

- Include a trigger phrase: "Load when {trigger}"
- Include what the skill covers
- Include what happens if you don't load it

Examples from existing skills:
```
description: "CRITICAL: Load when building or debugging OpenCode plugins. Missing this = silent failures, broken hooks, and wasted hours."
description: "IMPORTANT: Load when starting work on a project you haven't seen before. Scans the local workspace to understand project structure, tech stack, and existing documentation."
description: Load when creating a GitHub issue. Enforces correct template selection (bug/feature/other), title format with type prefix, label assignment, and body structure.
```

---

## Section conventions

### `## When to use me`
- Bullet list of specific triggers (file patterns, user phrases, task types)
- Be concrete, not abstract

### `## Not intended for`
- Bullet list of exclusions
- When applicable, redirect: `→ use \`{other-skill}\``
- OK to omit if the skill has no meaningful exclusions

### Content sections
- Use `###` for sub-sections within a phase or step
- Prefer tables, code blocks, and checklists over prose paragraphs
- Include commands the agent can run directly
- Include code snippets with language annotations

### `## References`
- Cross-reference related skills by name: `` `code-review` ``
- Reference project files (`.memory/`, config files)
- Reference external docs only when essential

---

## Tone and style
- Clean and professional — no emojis, no character voices
- Concise and direct — every line should be actionable
- One skill = one topic — never merge unrelated topics

---

## Verification checklist

Before finalizing a new skill:
- [ ] Directory and `name` match (kebab-case)
- [ ] Description follows click-bait rules (CRITICAL/IMPORTANT, trigger, what it covers, consequence)
- [ ] `## When to use me` has concrete triggers
- [ ] `## Not intended for` redirects to other skills where applicable
- [ ] Content is actionable (commands, patterns, rules)
- [ ] No emojis or character voices
- [ ] Cross-references existing skills correctly
