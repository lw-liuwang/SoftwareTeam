---
name: softwareteam-cmux
description: >
  Use when opening SoftwareTeam fleet terminals into cmux — turning a SoftwareTeam, pod, mission, slice, or saved
  view into live agent tiles via `SoftwareTeam terminal --provider cmux`, or driving cmux on an agent's
  request. Same SoftwareTeam view semantics as softwareteam-herdr (the verbs, honest-partial/degrade, read-only
  cross-SoftwareTeam, scroll/copy, same-size-only duplicates); cmux is the **best-effort** provider (herdr is
  the default and the proof-gated one). Prefer softwareteam-herdr unless cmux is specifically wanted.
metadata:
  softwareteam:
    stage: candidate
    sibling_skills:
      - softwareteam-herdr
      - softwareteam-user
---

# softwareteam-cmux

cmux is a **provider** for SoftwareTeam views — the same `SoftwareTeam terminal` surface as herdr, rendering the
tiles into cmux instead. It is the provider SoftwareTeam already shipped (the existing "Launch in cmux"
affordance generalizes onto `SoftwareTeam terminal <provider>`), kept working. The SoftwareTeam-semantic half is
identical to softwareteam-herdr: SoftwareTeam decides **which** agents form a view; the provider renders the
pixels. **Read softwareteam-herdr first for the full model** — this skill only calls out what differs for
cmux.

## Provider status — cmux is best-effort

- **herdr is the default and the proof-gated provider**; **cmux is best-effort** — it ships on the
  same `SoftwareTeam terminal <provider>` + web-launcher neighborhood, but a cmux miss is not a slice failure.
  Reach for cmux when it is specifically wanted; otherwise default to herdr (`SoftwareTeam terminal open <view>`
  with no `--provider`).
- Views are **provider-agnostic**: the same view + the same agents + the same semantics carry across
  herdr and cmux. A saved view opens in either.

## The surface (same three verbs, `--provider cmux`)

```bash
SoftwareTeam terminal open <view> --provider cmux [--json]   # open a view into cmux (herdr is the no-flag default)
SoftwareTeam terminal views [--json]                          # the same view library, provider-agnostic
SoftwareTeam terminal status --provider cmux [--json]         # cmux liveness / health
```

`<view>` resolves exactly as with herdr: a **SoftwareTeam name** · **`pod:<SoftwareTeam>/<podNamespace>`** ·
**`mission:<id>`** · **`slice:<id>`** (derived live) · a **saved-view name**.

## What carries over unchanged from softwareteam-herdr

All of these behave identically — see softwareteam-herdr for the detail:

- **Honest-partial / honest-degrade** — opened / absent / degraded, each named; partial opens exit 0,
  zero-pane exits non-zero; an http-registered host's agents degrade with the reason ("host `<id>` is
  http-registered; tiles need ssh"), never silently dropped.
- **Read-only policy** — a SoftwareTeam or `pod:` view is interactive; `mission:` / `slice:` views are
  read-only by construction; a saved view is per-member (`readOnly`). A read-only pane is
  `tmux attach -r` (client `readonly=1`, keystrokes physically cannot reach the agent). See softwareteam-herdr.
- **Safety rails (the fleet-safety rail)** — a tile is a *view* (nested `tmux attach`) of a
  daemon-owned session; never move/join/kill/re-parent a daemon-owned pane; closing a tile detaches
  one client and leaves the session untouched; never live-flip tmux options on a running seat in
  production (prove it in an isolated environment first).
- **Scroll + copy out of the box** — the daemon's terminal defaults (per-session scroll at launch +
  the server's clipboard defaults); running seats pick up wheel-scroll at their next relaunch.
- **Limits** — tile chrome v1 = a plain label; same-size panes for duplicate/multi-view membership
  (the different-size resize mismatch is an inherent tmux multi-client limit, documented not fixed).

## cmux-specific notes

- **Open-or-focus per agent** — cmux's shipped integration opens a node or focuses it if already open;
  expect focus (not a duplicate) when a seat is already tiled in cmux.
- **The shipped "Launch in cmux" affordance is preserved** (byte-compatible) and generalizes into the
  provider + view picker; opening cmux from the web launcher still works.
- **No AGPL arm's-length concern** — unlike herdr, cmux is SoftwareTeam's shipped provider integration; the
  clean-room/never-embed rail that applies to herdr is not a cmux constraint. (This skill itself is
  still authored clean-room.)

## Saved views — provider-agnostic

Saved views are **hand-authored** in `terminal-views.yaml` (v1 has no save/write verb) and are
**provider-agnostic** — see **softwareteam-herdr** for the exact schema, the store facts (atomic tmp+rename,
byte-stable, at the SoftwareTeam home root), and the derived-views-never-persisted rule. Reopen any saved
view in cmux with `SoftwareTeam terminal open <id> --provider cmux`. Derived views (a SoftwareTeam, `pod:<SoftwareTeam>/<pod>`,
`mission:<id>`, `slice:<id>`) are computed live and never written to the file.
