#!/bin/bash
set -euo pipefail

echo "=== SoftwareTeam North Star Demo ==="
echo ""

# Start daemon
echo "Starting daemon..."
if SoftwareTeam daemon start; then
  sleep 2
else
  echo "Daemon start returned non-zero; checking for an existing healthy daemon..."
  if SoftwareTeam ps --json >/dev/null 2>&1; then
    echo "Reusing existing healthy daemon."
  else
    echo "ERROR: daemon failed to start and no healthy daemon is available." >&2
    exit 1
  fi
fi

# Boot the demo topology
echo ""
echo "Booting demo topology..."
UP_OUTPUT=$(SoftwareTeam up demo/software-team.yaml)
printf '%s\n' "$UP_OUTPUT"
SOFTWARE_TEAM_ID=$(printf '%s\n' "$UP_OUTPUT" | sed -n 's/^SoftwareTeam: //p' | tail -n1)
if [ -z "$SOFTWARE_TEAM_ID" ]; then
  echo "ERROR: failed to determine softwareTeam ID from 'SoftwareTeam up' output." >&2
  exit 1
fi

# Show node status
echo ""
echo "Node status:"
# OPR.0.4.4.21: --nodes requires an explicit target outside a managed session.
SoftwareTeam ps --nodes --software-team "$SOFTWARE_TEAM_ID"

# Establish a restore-safe baseline for the demo softwareTeam.
echo ""
echo "Checking native resume baseline..."
if npx tsx demo/scripts/verify-native-resume.ts --software-team "$SOFTWARE_TEAM_ID"; then
  echo "Native resume baseline already ready."
else
  echo ""
  echo "Fresh Claude sessions are not restore-safe yet. Seeding one warmup turn per agent..."
  npx tsx demo/scripts/seed-resume-baseline.ts --software-team "$SOFTWARE_TEAM_ID" --max-rounds 1
fi

echo ""
echo "Final baseline status:"
npx tsx demo/scripts/check-demo-health.ts --software-team "$SOFTWARE_TEAM_ID"
npx tsx demo/scripts/verify-native-resume.ts --software-team "$SOFTWARE_TEAM_ID"

echo ""
echo "=== Demo topology is running ==="
echo "Dashboard: http://localhost:5173"
echo ""
echo "Next steps:"
echo "  SoftwareTeam ps --nodes --software-team '$SOFTWARE_TEAM_ID'   # Check node status"
echo "  SoftwareTeam down $SOFTWARE_TEAM_ID        # Tear down (auto-snapshots)"
echo "  SoftwareTeam restore <snapshotId> --software-team $SOFTWARE_TEAM_ID   # Restore the exact snapshot you just created"
