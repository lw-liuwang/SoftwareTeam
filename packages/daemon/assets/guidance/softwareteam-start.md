# SoftwareTeam Start

You are running inside a SoftwareTeam-managed topology — a persistent team of agents in separate
terminals, each with a name and a role, talking to each other directly.

**This file is deliberately thin.** Its only job is to get you your identity. It is not an
orientation, and it cannot tell you what your SoftwareTeam is for or what you are supposed to be doing.

## Identity — run this first

```bash
SoftwareTeam whoami --json
```

Returns your SoftwareTeam, pod, member, peers, edges, and transcript path. If `peersNote` says some peers
are not shown, `SoftwareTeam whoami --json --all-peers` lists them all. **Treat it as ground truth.**
The startup overlay may be stale.

Run it again after any compaction, restart or restore — **before** concluding anything about
where you are or what you were doing. And if a predecessor's transcript looks thin or empty,
know that transcript capture is unreliable on some runtimes — **little or no output does not
mean the session was quiet.**

## Reaching a peer

```bash
SoftwareTeam send <session> "message"     # types into their terminal and presses enter
SoftwareTeam capture <session>            # reads what is on their screen
```

The session name is the address. `SoftwareTeam --help` lists the rest of the surface.

## Fresh-seat orientation

Fresh seats normally also receive `softwareteam-onboarding-01.md` and
`softwareteam-onboarding-02.md`. They give a compact mental model before role-specific work begins.
Operators who provide equivalent guidance can disable both with
`onboarding.default_pack.enabled`; this identity pointer remains available.

## When SoftwareTeam itself misbehaves

Run `SoftwareTeam context get help`. It provides version-matched troubleshooting and recovery steps. If `SoftwareTeam`
itself won't run, read `daemon/docs/reference/help.md` inside the installed `@softwareteam/cli` package,
or `docs/reference/help.md` in this checkout.

## What this file is not

It is not the manual, and these commands are a fraction of what is available.

**If nobody has walked you through this system, say so rather than inferring it.** What your SoftwareTeam
is for, how work moves here, and what you are allowed to do are not in this file and are not
guessable from it — and guessing your way into a SoftwareTeam is how an agent builds the wrong thing
correctly.
