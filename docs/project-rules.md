# Project Rules

## Authority

- `AGENTS.md` is the entry point for agent workflow and repository boundaries.
- `docs/contributing.md` defines coding, feature, UI, and release rules.
- `docs/feature-patterns.md` defines implementation patterns.
- `docs/architecture.md` defines module boundaries and build structure.
- Game facts belong in `docs/game/`; feature-specific behavior belongs with the feature.
- Current behavior wins. Historical notes and superseded decisions do not belong in source comments.

## Comments

Comments are part of the maintenance surface. Add one only when the code cannot make the rule clear.

Keep:

- current invariants and non-obvious business rules;
- external constraints, including game or browser behavior;
- test scope and deliberate limitations;
- reasons for a workaround that would otherwise be removed incorrectly.

Remove:

- round-by-round debugging narratives;
- dates, user quotes, old implementations, and superseded conclusions;
- comments that restate the next line of code;
- duplicated documentation and historical sample values.

Regression scripts should start with a short current contract, usage, exit status, and limitations. Assertions should explain only the invariant they protect.

## Change workflow

1. Read the relevant docs before changing behavior.
2. Search for existing helpers, components, stores, and feature registrations.
3. Check open work before starting overlapping feature work.
4. Keep changes focused; do not mix unrelated cleanup.
5. Update every current documentation or comment that asserts changed behavior.
6. Run targeted checks, then `compile` and `lint` as appropriate.

Never edit `MEMORY.md` or `PROJECT_MEMORY.md` as part of normal work.
