# paintclash

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — the five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Session commits

At the end of a work session — e.g. after a Wayfinder ticket is resolved, or a discrete block of work is finished — create a **Conventional Commit** if there are changes to record:

- Format: `type(scope): summary` (types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, …).
- During the current planning phase most changes are `docs:` (spec / ADRs / issue tracker) or `chore:`.
- The message summarises *this* session; add a short body for the key points when useful.
- **Commit only — never push** unless explicitly asked.
- Useful scopes: `wayfinder`, `adr`, `spec`, or the feature slug (`draw-race`).

Example: `docs(wayfinder): resolve architecture ticket 08, add ADRs 0001–0006 + glossary`
