# Migrating a pre-convention SoftwareTeam's topology context

For SoftwareTeams whose hand-authored context predates the chain-file convention and
lives at the legacy location (`~/.softwareteam/shared-docs/SoftwareTeams/<SoftwareTeam>/`, or
`$SOFTWARETEAM_SHARED_DOCS_ROOT/SoftwareTeams/<SoftwareTeam>/`). Nothing here is destructive: the
legacy tree is left in place, `SoftwareTeam context trace` keeps reading it at the SoftwareTeam and
seat levels throughout (with an advisory), and every copy is no-clobber. The refocus
trace, `seat:` profile atoms and handover priming read only `topology.root`, so
they see these files only after migration.

## The path, with exact commands

```bash
# 0. Know both roots — never hardcode either.
DEST="$(SoftwareTeam config get topology.root)"
SRC="${SOFTWARETEAM_SHARED_DOCS_ROOT:-$HOME/.softwareteam/shared-docs}/SoftwareTeams"

# 1. BEFORE: prove the fallback is carrying this SoftwareTeam (expect ADVISORY lines
#    on stderr for every level that resolves at the legacy location).
SoftwareTeam context trace --software-team <SoftwareTeam> --seat <seat> --name LEARNED.md

# 2. Preview the migration (dry run — nothing moves).
rsync -av --ignore-existing --exclude 'state/' --dry-run "$SRC/<SoftwareTeam>/" "$DEST/SoftwareTeams/<SoftwareTeam>/"

# 3. Migrate. --ignore-existing mirrors the installer's copy-if-absent law:
#    anything already earned under topology.root is never overwritten.
mkdir -p "$DEST/SoftwareTeams/<SoftwareTeam>"
rsync -av --ignore-existing --exclude 'state/' "$SRC/<SoftwareTeam>/" "$DEST/SoftwareTeams/<SoftwareTeam>/"

# 4. AFTER: the same trace now resolves canonically — the advisories are gone.
SoftwareTeam context trace --software-team <SoftwareTeam> --seat <seat> --name LEARNED.md

# 5. Do NOT delete the legacy tree in the same session. Archive it later,
#    once every consumer (queue-state add-dirs, review artifacts, scripts)
#    has been confirmed off it — reads through the fallback stay correct in
#    the meantime, which is the point of fail-open.
```

## What migrates and what does not

- **Migrates:** the SoftwareTeam's chain files and seat directories — `LEARNED.md`,
  `CULTURE.md`, craft files, `seats/<seat>/…`.
- **Stays (for now):** `state/` (queue-state add-dirs and live artifacts are
  actively written by running seats; moving them under a live SoftwareTeam strands
  writers — that cutover is its own change with its own receipt).
- **Never:** anything into a running seat's context. Migration moves files;
  delivery to running seats is the refocus channel
  (`docs/reference/refocus-channel.md`) — editing a file is not delivery.

## After migration

The next `SoftwareTeam up` of a spec shipping topology defaults installs them
copy-if-absent alongside the migrated content — earned context always wins
over a shipped default. Verify any doubt with the trace, not with memory.
