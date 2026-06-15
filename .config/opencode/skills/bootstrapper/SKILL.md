---
name: bootstrapper
description: "CRITICAL: Load when onboarding a NEW repo that lacks skills. Scans the repo via GitHub MCP, detects tech stack, reads existing .github/instructions/ if any, and generates workflow-level skills in .agents/skills/. Works for ANY language/framework. Self-contained — no external dependencies."
---

## When to use me
- When a repo has no `.agents/skills/` directory
- When you need to scaffold skills from existing instructions or tech stack

## Not intended for
- Updating existing skills → read them first, ask user what to change
- Day-to-day coding → use project-specific skills instead
- Code review → use `code-review`

---

## Phase 0 — Verify Need (MANDATORY)

Before doing anything, check what already exists:

```
github_get_file_contents(owner, repo, ".agents/skills/")
github_get_file_contents(owner, repo, ".github/instructions/")
```

- If `.agents/skills/` exists → **STOP and ASK user** what they want to do. Never overwrite without permission.
- If `.github/instructions/` exists → note file paths, they'll be used as source material in Phase 2.

---

## Phase 1 — Discover Repo (GitHub MCP)

Scan the repo to detect tech stack. Use `github_get_file_contents` and `github_list_*` — never raw bash.

### Step 1: Root Structure
```
github_get_file_contents(owner, repo, "/")
```

### Step 2: Detect Build System

| File Found | Stack Detected | Language | Build Tool | Linter |
|------------|---------------|----------|------------|--------|
| `build.gradle.kts` | Kotlin/Java + Gradle | Kotlin | Gradle | ktlint |
| `build.gradle` | Java + Gradle | Java | Gradle | spotless |
| `package.json` | Node.js | JavaScript/TypeScript | npm/yarn/pnpm | ESLint |
| `Cargo.toml` | Rust | Rust | Cargo | clippy |
| `go.mod` | Go | Go | Go | golangci-lint |
| `pom.xml` | Java + Maven | Java | Maven | spotless |
| `pyproject.toml` | Python | Python | pip/poetry | ruff/flake8 |
| `Gemfile` | Ruby | Ruby | Bundler | rubocop |
| `pubspec.yaml` | Dart/Flutter | Dart | pub | dart analyze |

### Step 3: Read Build File

Read the build file to extract:
- Language version
- Key dependencies (frameworks, DI, testing, HTTP)
- Build commands (test, lint, build)
- Linter configuration

### Step 4: Detect Source Structure

```
github_get_file_contents(owner, repo, "src/")
```

Detect architecture patterns:
- `src/main/kotlin/` with `domain/`, `data/`, `presentation/` → Clean Architecture
- `src/main/kotlin/` with `commands/`, `services/` → Command Pattern
- `src/` with `components/`, `pages/` → React/frontend
- `src/` with `controllers/`, `models/` → MVC
- `lib/` → Library project

### Step 5: Check for Existing Config

```
github_get_file_contents(owner, repo, ".github/")
```

Look for:
- CI/CD workflows (`.github/workflows/`)
- Issue/PR templates
- CODEOWNERS
- Existing instructions

---

## Phase 2 — Create Skills

Create `.agents/skills/` with workflow-level skills derived from tech stack detection and any existing instruction files found in Phase 0.

**Relationship**: Each skill is a **condensed, actionable version** of a single topic. If `.github/instructions/{topic}.instructions.md` exists, use it as source material — extract commands, rules, and checklists. If no instruction file exists for a topic, derive the skill directly from Phase 1 discovery.

---

### Step 1: Create `quality-check` Skill (MANDATORY)

This is the **only required skill**. The qa.md subagent depends on it.

```markdown
---
name: quality-check
description: CRITICAL: Load BEFORE opening any PR. Missing this = failing gates and rejected PRs. Validates build, lint, tests. Pre-PR only.
---

## When to use me
- At the end of a task before opening a PR
- During PR review to validate locally

## Not intended for
- Day-to-day coding → use project-specific skills
- Code review → use `code-review`

---

## Quality Gates (MUST)

| Gate | Command | Status |
|------|---------|--------|
| Build | {build_command} | Must pass |
| Lint | {lint_check_command} | Must pass |
| Tests | {test_command} | Must pass |

## Run Sequentially

```
Build → Lint → Tests
```

Never run in parallel. Don't test code that doesn't compile.

## Step 1 — Build
```bash
{build_command}
```

## Step 2 — Lint (Auto-correct first)
```bash
{lint_fix_command}
{lint_check_command}
```

## Step 3 — Tests
```bash
{test_command}
```

## Reporting
- **BLOCKER**: Failing build, failing tests, lint errors
- **WARNING**: Non-blocking improvements
```

---

### Step 2: Derive Skills from Discovery and Instructions

For each topic detected in Phase 1 (or each instruction file found in Phase 0), create at least one skill.

**Rule**: If `.github/instructions/{topic}.instructions.md` exists, it MUST have a corresponding skill. No exceptions.

For each instruction, decide the skill density:

1. **Action-heavy instructions** (testing, code-style, architecture patterns) → Create a dense skill with rules, commands, checklists. The agent works mostly from the skill.

2. **Dense reference instructions** (data layer policies, API contracts, complex architecture) → Create a "loader" skill that tells the agent *when* to load the full instruction file. The skill has triggers, detection rules, and key blockers — but defers details to the instruction file.

3. **One instruction → many skills OK** — if an instruction covers distinct workflows, split into multiple skills:
   - `testing.instructions.md` → `testing` skill (write tests) + `mocking` skill (mock patterns)
   - `code-style.instructions.md` → `code-quality` skill (formatting rules) + `refactoring` skill (patterns)

4. **One skill → one instruction only** — never merge multiple instruction files into one skill.

#### Loader Skill Example (for dense reference files)

When an instruction file is too dense to condense, create a lightweight skill that acts as a loader:

```markdown
---
name: data-layer
description: CRITICAL: Load when touching *UseCase.kt, *Repository.kt, *DataSource.kt, or *Mapper.kt. Wrong naming or broken layer boundaries = immediate PR rejection.
---

## When to use me
- When creating or modifying a **UseCase**, **Repository**, **DataSource**, or **Mapper**
- When wiring any of the above in a **Koin module**

## How to detect context
Use this skill if you see:
- Classes named `*UseCase`, `*Repository`, `*RepositoryImpl`
- Classes named `*DataSource`, `*ApiDataSource`, `*MemoryDataSource`
- Files named `*Mapper.kt`

## Key Rules (MUST)
- DataSource naming: `*ApiDataSource` for remote, never `*RemoteDataSource`
- Mappers: extension functions only, never class-based
- Repositories: return `Result<T>`, never throw exceptions
- DI: Koin only, `factoryOf` for stateless, `singleOf` for stateful

## Blockers (MUST NOT)
- Creating new `*RemoteDataSource` → use `*ApiDataSource`
- Creating class-based mapper → use extension functions
- Throwing exceptions from Repository → use `Result<T>`
- Bypassing layer boundaries

## Reference
Read the full instruction file for concrete examples and edge cases:
- `.github/instructions/data-layer.instructions.md`
```

**Key difference**: The loader skill has triggers, detection rules, and blockers — but points to the instruction file for full details. The agent loads the skill first, then reads the instruction file only when it needs more context.

---

### Skill Format (MANDATORY)

Every skill MUST follow this format. The `description` field is CRITICAL — it must include click-baity keywords (CRITICAL/IMPORTANT) so the agent lazy-loads the skill when it encounters them in context.

```markdown
---
name: skill-name
description: {CRITICAL/IMPORTANT}: Load when {trigger}. {What it covers}. {Consequence of not loading}.
---

## When to use me
- {trigger_1}
- {trigger_2}

## Not intended for
- {non_use_1} → use `{other_skill}`

---

## Content sections
{actionable content — commands, checklists, code blocks, tables}

## References
- `.github/instructions/{source}.instructions.md` — full context
- External docs (ktlint, mockk, etc.) — OK
- Project files (config, generated files) — OK
- Other `.instructions.md` files — NOT OK
```

### Description Click-Bait Rules

| Priority | Prefix | When to Use |
|----------|--------|-------------|
| Must have | `CRITICAL:` | Missing this causes failures (broken CI, runtime crashes, rejected PRs) |
| Should have | `IMPORTANT:` | Missing this causes quality issues or onboarding confusion |
| Nice to have | Plain description | Optional but helpful context |

**Rule of thumb**: If the skill prevents something BAD from happening → use `CRITICAL:`. If it improves quality → use `IMPORTANT:`.

---

### How to Condense an Instruction into a Skill

There are two skill types depending on instruction density:

#### Type 1: Dense Skill (for action-heavy instructions)

Extract only the **actionable** parts from the instruction file:

| Instruction Content | Skill Content |
|---------------------|---------------|
| Full explanations | Short descriptions (1-2 lines) |
| Conceptual overviews | Skip or reduce to "## When to use me" |
| Code examples | Keep — these are actionable |
| Commands | Keep — these are actionable |
| Best practices | Keep as bullet list |
| Common pitfalls | Keep as bullet list |
| Architecture diagrams | Skip — too detailed for a cheat sheet |
| References to other docs | Keep in "## References" section |

#### Type 2: Loader Skill (for dense reference instructions)

When the instruction file is too dense to condense, create a lightweight pointer:

| Section | Content |
|---------|---------|
| `## When to use me` | File patterns, class names, triggers |
| `## How to detect context` | Specific patterns to look for |
| `## Key Rules (MUST)` | Top 3-5 non-negotiable rules |
| `## Blockers (MUST NOT)` | Things that will get the PR rejected |
| `## Reference` | Path to the full instruction file |

**Think of it as**: Dense skill = cheat sheet you work from. Loader skill = "hey agent, read this file when you see these patterns."

---

## Phase 3 — Verify

After creating all skills, verify:

```bash
ls -la .agents/skills/
```

Report to user:
1. What was detected (tech stack, architecture)
2. What skills were created
3. What they should review before proceeding

---

## Anti-patterns

1. **Overwriting existing skills** — Always check first, ask user
2. **Creating too many skills** — Only create what makes sense
3. **Generic descriptions** — Be specific about when to load each skill
4. **Missing quality-check** — This breaks the qa.md workflow
5. **References to external files** — This skill must be self-contained
6. **Merging unrelated topics into one skill** — Each skill covers one topic only
