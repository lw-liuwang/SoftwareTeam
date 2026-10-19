#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'SoftwareTeam requires Node.js 22 or 24. Install Node.js, then rerun ./start.sh.' >&2; exit 1; }
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/scripts/softwareteam.mjs" start "$@"
