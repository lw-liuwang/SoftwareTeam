#!/usr/bin/env bash
# OPR.0.4.4.13 FR-3 — product-factory VPS bootstrap (runs ON the VPS).
#
# Fresh Ubuntu -> factory-ready: the smoke-tested manual sequence, productized.
#
# Usage (as root on a fresh Ubuntu 22.04/24.04 VPS):
#   ./bootstrap-product-factory-vps.sh --artifact <@softwareteam/cli@X.Y.Z | /path/to/softwareteam-cli.tgz> \
#     --authorized-key "ssh-ed25519 AAAA... operator@home" [--ts-authkey tskey-...]
#
# The script is deliberately stepwise and loud; each step is safe to re-run.
# It NEVER prints secret material. There is intentionally no `softwareTeam host
# bootstrap` verb (host verbs are capped at add/list/doctor) — this script +
# the runbook ARE the bootstrap path; the contract is the observable end
# state: home-base `softwareTeam host doctor <id>` all-green.

set -euo pipefail

ARTIFACT=""
AUTHORIZED_KEY=""
TS_AUTHKEY="${TS_AUTHKEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --authorized-key) AUTHORIZED_KEY="$2"; shift 2 ;;
    --ts-authkey) TS_AUTHKEY="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$ARTIFACT" ]] || { echo "--artifact is required (@softwareteam/cli@X.Y.Z or a packaged tarball path)" >&2; exit 1; }
[[ -n "$AUTHORIZED_KEY" ]] || { echo "--authorized-key is required (the HOME-BASE public key)" >&2; exit 1; }
[[ "$(id -u)" == "0" ]] || { echo "run as root (fresh-VPS bootstrap)" >&2; exit 1; }

step() { echo; echo "==> $*"; }

step "1/8 non-root softwareteam user (key-only)"
if ! id -u softwareteam >/dev/null 2>&1; then
  adduser --disabled-password --gecos "SoftwareTeam factory" softwareteam
  usermod -aG sudo softwareteam
  echo "softwareteam ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-softwareteam
  chmod 0440 /etc/sudoers.d/90-softwareteam
fi
install -d -m 0700 -o softwareteam -g softwareteam /home/softwareteam/.ssh
grep -qF "$AUTHORIZED_KEY" /home/softwareteam/.ssh/authorized_keys 2>/dev/null \
  || echo "$AUTHORIZED_KEY" >> /home/softwareteam/.ssh/authorized_keys
chown softwareteam:softwareteam /home/softwareteam/.ssh/authorized_keys
chmod 0600 /home/softwareteam/.ssh/authorized_keys

step "2/8 sshd hardening drop-in (the smoke test's exact posture)"
cat > /etc/ssh/sshd_config.d/99-softwareteam-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
EOF
sshd -t && systemctl reload ssh

step "3/8 UFW: default deny incoming; tailnet ingress allowed"
apt-get update -qq && apt-get install -y -qq ufw >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 >/dev/null
# Bootstrap escape hatch: keep public SSH open until Tailscale SSH path is
# verified, then remove it (runbook step; posture check flags it).
ufw allow OpenSSH >/dev/null || true
ufw --force enable >/dev/null
ufw status verbose

step "4/8 Tailscale (tag:softwareteam-vps; no routes, no exit node, no ts-ssh)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if [[ -n "$TS_AUTHKEY" ]]; then
  tailscale up --authkey "$TS_AUTHKEY" --advertise-tags=tag:softwareteam-vps --accept-routes=false
else
  echo "   (no --ts-authkey given; run 'tailscale up --advertise-tags=tag:softwareteam-vps --accept-routes=false' interactively)"
fi
tailscale set --ssh=false >/dev/null 2>&1 \
  || echo "   (Tailscale SSH disable skipped; after tailscale up, run: tailscale set --ssh=false)"

step "5/8 Node 22 + tmux (LTS — odd majors are refused by the CLI's ABI guard)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0] % 2')" != "0" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v tmux >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq tmux >/dev/null
fi
node --version
tmux -V

step "6/8 SoftwareTeam from the published artifact (no manual package patching)"
sudo -u softwareteam -H bash -lc "npm install -g '$ARTIFACT' || sudo npm install -g '$ARTIFACT'"
sudo -u softwareteam -H bash -lc "SoftwareTeam --version"

step "7/8 daemon + kernel"
sudo -u softwareteam -H bash -lc "SoftwareTeam daemon start --no-kernel && sleep 2 && SoftwareTeam daemon status"
sudo -u softwareteam -H bash -lc "SoftwareTeam up kernel || true"   # kernel spec optional on a bare factory

step "8/8 done — home-base steps"
cat <<'EOF'

VPS side complete. From the HOME BASE now:
  1. softwareTeam host add --id <id> --transport ssh --target <tailnet-alias-or-ip> --user softwareteam
  2. softwareTeam host doctor <id>                       # expect all green
  3. softwareTeam host doctor <id> --posture product-factory-vps [--public-addr <public-ip>]
  4. Remove the public-SSH escape hatch once the tailnet path is verified:
       sudo ufw delete allow OpenSSH            # on the VPS
EOF
