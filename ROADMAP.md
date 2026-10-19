# Roadmap

The ideas below were inherited from upstream OpenRig. Their issue numbers refer to upstream
history and do not establish this fork's commitments or current implementation status.
Current SoftwareTeam work is discussed in [repository issues](https://github.com/lw-liuwang/SoftwareTeam/issues).
There is no promised release schedule or fork roadmap board.

## How to help

1. Pick an item and comment on its issue to say you're working on it and coordinate with others. A maintainer can assign
   you to make that work visible. If it has no issue yet, open one first.
2. Read `CONTRIBUTING.md`, and ask your agent to use the `developing-softwareteam` skill. It's a map of how SoftwareTeam is
   built, tested and changed.
3. Open a pull request that says what a user gets and how you verified it.

If more than one pull request arrives for the same item, we take the best one, and the first equivalent one breaks a
tie. Feel free to coordinate on the issue first.

## Testing

- **Behavioural scenarios for more command families.** `docs/as-built/test-layers.md` has a "Help wanted" list of
  `SoftwareTeam` command families that have no scenario yet, each with a suggested first check. One family per pull request is
  ideal.

## Agents and runtimes

- **Codex seats that can reach the local daemon by default** (#275), with an easy opt-out.
- **Custom Codex providers such as Bedrock** (#194): accept providers that authenticate with an environment key, and
  forward their token.
- **Operator recovery for Pi and Oh My Pi seats** (#41).
- **More agent apps:** we're working out one way for any coding-agent CLI to plug into SoftwareTeam. More on this soon
  (design discussion: #43).

## Slack

- **A DM or private channel for single-user setups** (#313).
- **A channel map** (#192): one channel per seat, keyed by channel ID.

## Reliability and everyday use

- **A configurable readiness window for fresh launches** (#182), so seats under load don't time out at a fixed 30
  seconds.
- **Draft-aware delivery** (#48): automated sends wait while someone is typing in a seat, or a seat can be set to
  inbox-only.
- **A host-aware resource budget for seats** (#80).
- **Predictable `SoftwareTeam up` over a stopped SoftwareTeam with the same name.**
- **Codex seats that leave a repository's tracked `AGENTS.md` alone** (related: #64).
- **Install and run on Node 26.**

Bugs aren't listed here. Please file them as issues; anything labelled `good first issue` is a good place to start.
