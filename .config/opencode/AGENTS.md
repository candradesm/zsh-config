Follow this guide to get the job done right. If anything is unclear, ask before proceeding.

**CRITICAL**: If source code for a library or dependency cannot be found, do NOT attempt to decompile it. Stop and ask Senior Engineer to indicate where the source code is located before continuing.

### Before Starting ANY Task:
- Review relevant files in `.memory/` and documentation in `code/.github/` only when needed.
- Do **not** load or inject the full content of `.memory/` or `code/.github/` directories into the assistant's context by default.
- If you need information from these folders, extract or summarize only what is necessary for the current task.
- If something is unclear or lacking context, ask.

### Organization & Checklist
1. Make a markdown checklist for each task.
    - [ ] Analyze requirements
    - [ ] Prepare files
    - [ ] Implement functionality
    - [ ] Handle edge cases
    - [ ] Write and run unit tests (mandatory)
    - [ ] Verify results
2. Update the checklist as you go. This helps prevent missed steps.

### Basic Universal Rules
- Always write clean, maintainable code.
- Use the async patterns established in the project.
- Use the architectural patterns established in the project.
- Use the language established in the project unless Senior instructs otherwise.

### Common Pitfalls to Avoid
- Never install anything without Senior's approval.
- Never assume framework or version, verify or ask first.
- If a skill or automation contradicts `code/.github/`, ask Senior for clarification.
- **CRITICAL**: ALWAYS prefer available tools and MCPs configured in your environment over raw bash commands for any operation they support. Only fall back to bash when no available tool or MCP covers the required operation.
- **CRITICAL**: If source code for a library or dependency cannot be found, do NOT attempt to decompile it. Stop and ask Senior Engineer to indicate where the source code is located before continuing.
