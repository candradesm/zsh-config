---
name: create-issue
description: Load when creating a GitHub issue. Enforces correct template selection (bug/feature/other), title format with type prefix, label assignment, and body structure.
---

## Issue types

| Type | Title prefix | Labels |
|---|---|---|
| Bug | `[BUG] Short description` | `bug` |
| Feature / Task | `[Suggestion] Short description` | `suggestion`, `enhancement` |
| Other | `[Other] Short description` | `help wanted` |

## Templates

### Bug
```markdown
**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Media**
If applicable, add screenshots or a video to help explain your problem.

**Additional context**
Add any other context about the problem here.
```

### Feature / Task
```markdown
**Is your feature request related to a problem? Please describe.**
A clear and concise description of what the problem is.

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**Describe alternatives you've considered**
A clear and concise description of any alternative solutions or features you've considered.

**Additional context**
Add any other context or screenshots about the feature request here.

**Media**
Media to further explain this suggestion.
```

### Other
```markdown
**Other issue? Please describe.**
A clear and concise description of what the problem is.

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**Media**
Media to further explain this issue.
```

## Rules
- Use the correct template for the issue type
- Keep titles concise but descriptive
- Assign relevant labels
- Link related issues/PRs with `#number`
