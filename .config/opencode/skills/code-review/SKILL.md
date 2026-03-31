---
name: code-review
description: Load when reviewing implementation quality after a feature or fix. Enforces code quality rules per file type (Koin, MockK, strings, XML). Produces BLOCKER/ROAST/PRAISE report. Not for quality gates — use /quality-check for that.
---

## When to use me
- After implementation is complete and you need to assess **code quality**.
- When the GOAT Roaster 🐐 is invoked to review Junior Monke's work.
- During PR review to identify architectural, design, and style violations.

## Not intended for
- Running build/test/lint gates → use `/quality-check` for that.
- Day-to-day coding guidance → use `/architecture`, `/testing` instead.

---

## Step 0 — Detect changed files (MANDATORY)

Before forming any opinion, always run:
```bash
git diff --name-only HEAD
```
Then read **every changed file** before writing the review. Never review from memory or assumptions.

---

## Review checklist (apply per file type)

### UI / Compose (`*Screen.kt`, `*Composable.kt`, `*Fragment.kt`, `*Activity.kt`, XML layouts)
- **Design system compliance**: use project-specific components and tokens — no hardcoded values
- **Previews**: use the real composable with meaningful sample data; no parallel/mock UI implementations; omit entirely if Koin DI prevents it
- **No hardcoded user-facing strings**: use `stringResource(R.string.existing_key)` or `@StringRes` params; never raw literals
- **XML IDs**: camelCase (e.g. `@+id/titleLabel`); layout filenames: snake_case (e.g. `dialog_my_screen.xml`)
- **No logic in UI layer**: layout calculations, business decisions, and state belong in the ViewModel

### Architecture / ViewModel (`*ViewModel.kt`, `*Contract.kt`, `*State.kt`)
- **MVI pattern**: Actions (VM→View) and Events (View→VM) — never plain callbacks or LiveData-only patterns
- **Koin only for DI**: no `@Inject`, no `hiltViewModel()`, no `DiHelper.get()` static lookups — use Koin property delegates
- **No MVP in new code**: `*Presenter` classes are legacy only; new screens must use MVI
- **Immutable state**: all mutable vars in the ViewModel must be encapsulated as a single `State` data class; no loose `var` fields
- **StateFlow + SingleLiveEvent**: StateFlow for UI state, SingleLiveEvent for one-shot Actions

### Data layer (`*UseCase.kt`, `*Repository.kt`, `*DataSource.kt`, `*Mapper.kt`)
- **DataSource naming**: `ApiDataSource`, `MemoryDataSource`, `PreferencesDataSource`, `DiskDataSource` — never generic names
- **Mappers**: extension functions only (`.toModel()`, `.toUIModel()`, `.toApiModel()`) — never mapper classes
- **Result<T>**: all repository and datasource methods must return `Result<T>` for error handling
- **Layer boundaries**: UseCases call Repository interfaces only; no DataSource access from ViewModel

### Tests (`*Test.kt`)
- **MockK only**: no Mockito (`mock()`, `verify()`, `whenever()`) — use `mockk()`, `every {}`, `verify {}`
- **No relaxed mocks**: never `mockk(relaxed = true)` — declare every mock explicitly
- **GIVEN-WHEN-THEN naming**: `fun given_X_when_Y_then_Z()`
- **TestAppDispatchers**: never mock `AppDispatchers` directly — use `TestAppDispatchers`
- **Coverage**: logic changes must have tests; UI/models/mappers are excluded from coverage requirements

### Kotlin quality
- **Idiomatic Kotlin**: no Java-isms (`!!` abuse, null checks instead of `?.let`, `get()`/`set()` instead of properties)
- **No magic numbers**: extract constants with meaningful names
- **No dead code**: no commented-out blocks, unused imports, or unreachable branches
- **No TODO bombs**: scattered `// TODO` without context or ticket reference are a smell

---

## Reporting format

- **BLOCKER**: architectural violations, wrong DI, hardcoded strings, missing tests for changed logic, MVP in new code
- **ROAST**: suboptimal but not blocking — design smells, weak tests, poor naming, Java-isms, magic numbers, God classes
- **PRAISE**: genuinely good work — be stingy, only award when truly deserved

---

## References
Load these for deeper rule details if needed:
- `/architecture` — MVI, Koin details
- `/architecture-data-layer` — DataSource naming, mapper policy, Result<T>
- `/testing` — MockK patterns, GIVEN-WHEN-THEN, coverage exclusions
