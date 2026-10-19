# Getting started: meet the kernel, then make one useful change

Install SoftwareTeam, use a working provider login, and meet the kernel operator with
the advisor and TUI beside it. No starter team is needed to reach that view.
Tell the operator what you want to do, then choose a project team for a bounded
change you can exercise. Reuse the accounts and terminal tools you already have.

After installation and sign-in, your agent opens the **SoftwareTeam TUI and operator** for you. The path is `SoftwareTeam daemon start` (if stopped),
then `SoftwareTeam terminal open saved:kernel --window`. The second command opens the
desktop window itself. An agent can run it from its shell on the daemon's
desktop; it does not need to type into your current terminal. See
[Open the kernel conversations](#open-the-kernel-conversations).
`SoftwareTeam tui` is the team dashboard; installation ends when you are talking to the
operator in the SoftwareTeam view.

## Before you start

You need Node.js 22 or 24 and tmux, on macOS or Linux. On Linux, the
distribution's own Node.js can be older (Ubuntu 24.04's is 18); install a
supported version with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`)
or NodeSource. On a Mac with Apple
silicon, use Node.js 22 (see the [compatibility
history](../releases/v0.5.15.md#known-compatibility-limitation)). Native
Windows isn't supported. On Windows, use WSL2: it's the Windows route SoftwareTeam
supports, though SoftwareTeam's automated tests don't run on it yet. One user's
[working setup](#wsl2-a-reported-working-setup) is below. Node 20 and
odd-numbered releases (23, 25 and so on) are not supported; Node 26 and later
even-numbered releases are untested.

**Choose permissions before starting the team.** Ordinary SoftwareTeam launches use
Codex's `-s workspace-write`, with approval policy from your native configuration,
or Claude Code's `acceptEdits`, which still leaves commands subject to native
rules and prompts. A team seat with no permission policy, per-seat choice or
(for Codex) named profile also gets a per-launch
[team default](software-team-spec.md#team-launch-defaults): Claude runs ordinary `SoftwareTeam`
commands, project reads and common tests without prompting, while lifecycle
commands such as `SoftwareTeam up` and `SoftwareTeam down` still ask; Codex also gets the SoftwareTeam
workspace root and its pod's state directory as writable directories. The
kernel's own seats get a wider operational default. Codex's
sandbox normally blocks network access, including the local SoftwareTeam daemon, so
before that plain launch SoftwareTeam asks Codex for its own configuration and adds
network access inside the sandbox only when Codex answers that no configuration
layer sets `sandbox_workspace_write.network_access` and no managed requirement
could restrict it; if Codex can't be asked or doesn't answer in time, the launch
is left unchanged. To keep it off, set `network_access = false` under
`[sandbox_workspace_write]` in your Codex configuration. If Codex does not answer
within a few seconds, the seat starts without it. A command allowance does not
change general sandbox/network settings. The starter's `profile: default` selects SoftwareTeam resources, not a native
permission profile.
Agent-guided setup [recommends keeping the team default](#have-your-agent-configure-permissions)
and offers to remember selected SoftwareTeam commands in your native settings only if
you want that. An existing explicit choice is reused; No or no answer keeps the
team default and leaves settings unchanged. Broader access is separate.

If permission prompts are slowing you down, consider the
[external upstream workshop bundle](https://github.com/mvschwarz/openrig-world/tree/main/rigs/workshop). It ships with broad access
and [non-interruptive mode](non-interruptive-mode.md): its agents bypass
permission prompts and supported harness warning dialogs. The listing and
before-install view explain that access before you choose it.

> Everything below reports **what is currently true**, never a guarantee that
> downstream work will succeed. "Daemon up" does not mean every agent is healthy;
> "kernel ready" does not mean every kernel agent is healthy; a workspace root
> being *live* does not mean it is the *right* one for your project.

## WSL2: a reported working setup

WSL2 is the Windows route SoftwareTeam supports. SoftwareTeam's automated tests don't run on
it yet; this is one user's working setup.
[dajiaohuang](https://github.com/dajiaohuang)
[ran upstream OpenRig 0.6.6 under WSL2](https://github.com/mvschwarz/openrig/issues/88#issuecomment-6043925546)
on Ubuntu 24.04, with Node.js 24.14.1, tmux 3.4, Codex CLI 0.161.0 and Pi
(`@earendil-works/pi-coding-agent`) 1.0.4, headless, as the distribution's root
user.

- **What worked**, with one Codex seat and one Pi seat: `SoftwareTeam doctor`, starting
  the daemon (`SoftwareTeam daemon start --no-kernel`), launching both seats, replies to
  `SoftwareTeam send` and `SoftwareTeam capture`, and stopping with `SoftwareTeam down --snapshot`
  followed by a warm restore with `SoftwareTeam up --existing`.
- **What mattered:**
  - the install and the SoftwareTeam instance on the Linux filesystem;
  - Linux-native Node.js and harnesses, not the Windows `npm` or `pi` that WSL
    inherits;
  - Pi credentials the managed seat can reach, because a global Pi login isn't
    shared with managed seats. This user put them in the seat's agent
    directory. For `openrouter`, `zai`, `kimi-coding` or `minimax`, a key in the
    daemon environment also works (`OPENROUTER_API_KEY`, `ZAI_API_KEY`,
    `KIMI_API_KEY` or `MINIMAX_API_KEY`): name it in
    `recovery.provider_auth_env_allowlist`, give the seat a `<provider>/<id>`
    model, then restart the daemon and relaunch the seat. Any other provider
    goes in the seat's agent directory;
  - the current `@earendil-works/pi-coding-agent` package in its own npm prefix,
    not the deprecated `@mariozechner` one.
- **Not tested:** the kernel and operator, herdr, reboot, suspend and resume,
  cross-host operation and long-running work.

## Install and sign in

Use a local source checkout with Linux/macOS, Node.js 22 or 24, npm, Git, tmux,
and the selected Codex or Claude Code executable. From the checkout root:

```sh
./install.sh --runtime codex
./start.sh --name my-team --runtime codex
```

Use `--runtime claude-code` for Claude Code. Startup also bootstraps a cold checkout.
No globally published SoftwareTeam package or upstream installer is required.
The installer builds this checkout and installs it inside the selected private state.
Native SQLite builds may require Python and a C/C++ toolchain.

First startup checks only the selected provider inside the fresh SoftwareTeam account.
If it is not authenticated, startup exits with `authentication_required` and prints
the exact scoped login command. Complete that login, then rerun startup. Existing
provider credentials are not copied or imported. Help, `--dry-run` and `--check`
work before dependencies are installed and do not write state.

The seven experts use the product/dev groups. With `--name my-team`, management is
`product-manage-agent@<name>` with the selected name substituted. Omitted names reuse the saved selection, with
`software-team` as the fresh default. A different explicit name requires a fresh
`--state-dir /absolute/path`. The controller accepts portable slugs matching
`^[A-Za-z0-9][A-Za-z0-9_-]*$`, except `external` and `kernel`.

The root startup opens the team terminal after exact seven-seat readiness; use
`--headless` to receive the private-socket management attachment command instead.
Web stays off by default. To enable it, run `SoftwareTeam config set ui.enabled true`
and explicitly restart the owned daemon; `SoftwareTeam ui open` prints the URL
and requests a browser. See the root README for current instance behavior.

The remaining sections document the generic kernel and team engine commands.
The root seven-expert launcher uses `--no-kernel` deliberately and does not require
manually following those engine setup steps.

## Start the kernel and check its state

With a working selected login, start the daemon if it is stopped, then read its
state and the kernel seats:

```sh
SoftwareTeam daemon start  # only if the daemon is stopped
SoftwareTeam status
SoftwareTeam ps --nodes --software-team kernel
```

Starting the kernel, including its operator and advisor, is part of installing
SoftwareTeam. Keep it for a normal install: it helps you choose and start your project
team. `SoftwareTeam daemon start --no-kernel` is for automation or an explicit request to
omit the kernel; it leaves you without that operator.

On a fresh instance, explicit daemon startup chooses the kernel variant from
successful native auth probes: Claude alone, Codex alone, or both. It starts the
kernel in the background without a project starter. An absent unused provider is
fine; if both accounts are authenticated, the kernel uses both even when your
later project uses just one. A request to use only one provider for everything
is a separate choice.

**Started is not ready.** Read the `Kernel:` boot state in `SoftwareTeam status` and the
individual seat state in `SoftwareTeam ps --nodes --software-team kernel`. The view may open while
agents finish starting; describe that state, without claiming they are ready.
A missing or unknown readiness signal is not proof of readiness. Follow
[Incomplete setup and restart](#incomplete-setup-and-restart) for login, trust,
startup or missing-seat problems.

`SoftwareTeam setup` itself does not start the daemon. Preserve a daemon and kernel that
already exist: ordinary daemon startup skips a managed kernel, and
`SOFTWARETEAM_NO_KERNEL=1` skips automatic kernel startup. If neither runtime is
authenticated, kernel boot reports `auth_blocked`. Do not restart or recreate an
existing kernel merely to open its view. The startup TUI (`SoftwareTeam`) offers its own
kernel setup and individual-seat recovery; it does not automatically boot agents
when it starts the daemon.

## Open the kernel conversations

This is the **SoftwareTeam view**, in a new terminal window or tab.
Below 120 measured columns, the operator fills the first page; from 120, the dashboard and operator share it equally.
The advisor always has a separate tab or tmux window.
**Agents:** the `SoftwareTeams` skill says when to open it, what to check, what to do when it can't open, and how to hand the
person's goal to the operator; [Install and sign in](#install-and-sign-in) says how to load it.

`SoftwareTeam setup` installs Herdr by default on macOS and Linux. If the person declines
Herdr, use `SoftwareTeam setup --no-herdr`; the SoftwareTeam view can use plain tmux. Setup
checks both PATH and the installer's default `~/.local/bin/herdr` location. It
leaves existing cmux settings alone and does not open a view during setup.

On a Mac, the installing agent also asks once, "Install Ghostty for the SoftwareTeam
view?" On Yes it reruns setup with `--ghostty`, preserving earlier choices such
as `--no-herdr` and `--providers`. This installs the
[documented Homebrew cask](https://ghostty.org/docs/install/binary) and checks for
the app. On No it uses `--no-ghostty`; Terminal.app remains available. Plain setup
reports this offer without installing Ghostty or waiting for input. The person
types no command.

This command opens it in a new terminal tab or window itself, so nobody copies or types commands. Over SSH or
without a local display it can't, and the [headless handoff](#headless-or-ssh-handoff) applies:

```sh
SoftwareTeam terminal open saved:kernel --window --json
```

Run this on the daemon's desktop, as the same user. On macOS, the command
opens a new tab or window in the hosting Ghostty (1.3 or newer), or a new
window when hosted by Terminal. For Claude Desktop, iTerm or VS Code, it checks
for a local macOS desktop session and opens a new Ghostty window if its scripting
support is confirmed (1.3 or newer), otherwise Terminal.app with an explanation.
That window uses the app's own profile defaults because
there is no hosting window to copy. Before running the command, the agent should say that clicking **Allow**
on macOS's one-time control prompt is fine: it lets SoftwareTeam open the requested
SoftwareTeam view. A denied or uncertain action is reported once, not replayed in
another app. If macOS remembers a denial, enable the calling app in System Settings
→ Privacy & Security → Automation, or use the printed command in a terminal yourself.
Unknown width keeps the operator-only layout.

When the agent already runs inside Herdr, the command focuses a space with the
same view and plan, or creates one if none matches, preserving its config and existing spaces. The
caller's Herdr endpoint must match the daemon's endpoint; a mismatch is reported
without opening a window or putting the view in another session.

On Linux, a local graphical display and a supported hosting terminal are required
(Ghostty, GNOME Terminal, Konsole or xterm). Linux reports a window request; verify
what actually appeared. SSH, headless, CI and unsupported Linux hosts get a
no-window result with the reason, a command for the person to run, and any
follow-up the agent needs to perform.

SoftwareTeam's Herdr launch and its printed manual command keep your personal Herdr
config when present. If it is absent, SoftwareTeam creates private sidebar defaults;
the new desktop terminal selects them from its measured width. The manual command
uses the collapsed default. If private settings cannot be prepared, SoftwareTeam
reports why and keeps the ordinary launch or manual command with Herdr's usual settings.

The command runs Herdr when installed, using the daemon's configured session and
socket. Otherwise it creates a plain tmux viewing session. Explicitly choose the
latter with `--provider tmux --window`. Neither route types into or replaces the
installing agent's terminal. Existing conversations continue in their original
sessions.

Opening the same Herdr view with the same current plan selects its existing
SoftwareTeam workspace in the new window, preserving its tabs and contents. The receipt
reports reuse and any currently absent or degraded seats; it does not claim to
refresh the layout or create new tiles. Changed membership or attachment targets
create a fresh workspace. A note identifies older workspaces and gives the command
to close them after inspection; nothing is closed automatically. If the workspace
inventory cannot be read, the command creates a fresh workspace and reports the
inventory problem.

Terminal.app copies the person's front-window bounds to the new view without
changing the original. Ghostty keeps the current window size when adding a tab.
SoftwareTeam keeps an existing personal Herdr config unchanged. Only when that config
is absent, its private default starts the sidebar open at 160 columns or more,
and collapsed below that width. Unknown widths use the collapsed default.

### Confirm the view

For Claude-only, Codex-only and mixed kernels, the default `saved:kernel` layout
uses the viewing terminal's measured width. Below 120 columns (or when width is
unknown), **the operator** fills the first page, followed by dashboard and advisor
pages. From 120 columns, dashboard and operator share the first page equally, with
the advisor on a separate page. Select a Herdr tab to switch; in plain tmux, press
**Ctrl-b, then w** and choose a `view-*` window; `view-1` is the SoftwareTeam view's first page.
Missing roles are reported rather than filled with another conversation. The queue worker remains
reachable through the dashboard. The composition uses the installed kernel's current
bindings; no YAML edit, seat launch or daemon restart is needed. A custom saved
view named `kernel` still takes precedence.

Inspect `opened`, `absent`, `degraded`, `window` and any notes. Confirm the new
surface visibly shows the operator, with the dashboard and advisor reachable,
and that the original terminal remains intact. The person sees Herdr only in a terminal they can see.
Creating its workspace or switching the shared TUI to `:terminals` does not open
that terminal. A created window or successful CLI response alone is not visual
confirmation. A partial view remains partial. If the shared TUI tile shows a
shell, the installing agent starts `SoftwareTeam tui` in that new tile.

Opening the view can happen while the kernel finishes starting. Report its actual
state; do not start or restore seats just to obtain a view. If the kernel is absent
or blocked, follow [Incomplete setup and restart](#incomplete-setup-and-restart).

### What can interrupt installation and the SoftwareTeam view

For an installing agent, a blocked step needs an explanation, not silence. Name
the command, the reported reason and what remains unfinished. These checks cover
different points in the same journey:

| What you see | Why and what to do next |
| --- | --- |
| Codex offers to switch to a cheaper model near a rate limit | This is Codex's own menu. Ask the person to choose in the seat's terminal; do not silently change the team's configured model. SoftwareTeam disables Codex's startup update check for managed launches, but does not answer this model-choice menu. |
| A missing Node.js, npm or tmux; an install download or command fails | The named prerequisite or install step did not finish. Read its error and the [platform and provider instructions](#install-and-sign-in), resolve that step, then recheck it. `FAILED [4/4]` with only selected-provider sign-ins outstanding means the package installed but those logins still need the person. |
| The installing harness refuses a tool call or asks for permission | Its native rules, sandbox or automatic permission decision apply before SoftwareTeam can run. Claude Code's [auto mode can deny calls](https://code.claude.com/docs/en/auto-mode-config) as well as approve them. Show the specific refusal and ask the person to review it in the harness permission controls or run that named step themselves. Keep their chosen restrictions; a refused call does not prove the SoftwareTeam command failed. |
| Herdr or Ghostty installation is unavailable or declined | Herdr is optional for the view: `--window` uses plain tmux when Herdr is absent, and its install failure is a warning. On macOS, Terminal.app is the fallback when supported Ghostty is absent. An explicitly requested Ghostty install can fail setup; resolve that install or decline it with `--no-ghostty`, preserving earlier choices. Address separate required-tool or login failures. Existing cmux remains supported. |
| macOS asks for Automation access, or the window action is denied | The command asks the desktop terminal app to open a new surface. Let the person answer the system prompt. Read the error and inspect any new window before retrying an uncertain action; do not silently switch apps and open a duplicate. |
| No local display, or the configured daemon is remote | `--window` needs the daemon's desktop. An SSH shell or remote daemon address alone does not give the agent that desktop. Explain the limit and use the [manual](#talk-to-the-operator-in-any-terminal) or [SSH handoff](#headless-or-ssh-handoff) with the actual operator binding. |
| Herdr shows its introduction or agent-integration panel | These are Herdr's first-run panels. Follow the displayed controls: Return continues the intro and Esc closes the integration panel. Opening this view does not require installing Herdr's agent integrations or changing your Claude/Codex settings. |
| A saved layout is cramped in an 80×24 window | The default kernel view gives each role a full-width page. A custom saved `kernel` view still controls its own layout; adjust that saved view if needed. Changing or restarting the team is unnecessary. |
| The command returned, but visibility is unconfirmed | With authorized desktop tools, inspect the new window and a screenshot of its contents. A window listing alone proves only that a window exists. If the agent has only shell access, report what the command confirmed and ask the person to confirm the visible operator and that the dashboard and advisor tabs or windows are available. Do not report visual success without seeing it. |
| In a Claude Code seat's terminal, Shift+Enter submits instead of adding a newline | Whether Shift+Enter reaches Claude Code as its own key depends on the terminal and on tmux's extended-key support and settings ([`extended-keys`](https://man.openbsd.org/tmux.1#extended-keys), [`terminal-features`](https://man.openbsd.org/tmux.1#terminal-features__)). To add a newline anyway, press Ctrl+J, or type `\` and then press Enter. Claude Code's [tmux configuration guide](https://code.claude.com/docs/en/terminal-config#configure-tmux) covers the setup. |

After a failure, inspect any newly opened surface before retrying. A tmux failure
may name a newly created viewing session for inspection. Do not replace a failed
local desktop action with commands for the person to copy; finish or explain the
failed action. Close only the viewing window, or use **Ctrl-b, then d** in plain
tmux, to leave the underlying conversations running.

### Existing provider workspaces

The existing provider-only commands remain available when a terminal is already
open. They create a workspace inside that provider, without opening an OS window:

```sh
SoftwareTeam terminal views --json
SoftwareTeam terminal open saved:kernel --provider herdr --json
SoftwareTeam terminal open saved:kernel --provider cmux --json
```

Use `SoftwareTeam terminal status --json` to inspect provider availability and liveness.
For the first desktop handoff, use `--window`. Only if the window cannot open,
`SoftwareTeam tui --shared` is the dashboard-only fallback, not the operator's conversation.

### Talk to the operator in any terminal

For an explicitly requested manual attachment, inspect the current bindings:

```sh
SoftwareTeam ps --nodes --software-team kernel --json --fields logicalId,canonicalSessionName,tmuxAttachCommand
```

Find `logicalId: operator.agent` and run its `tmuxAttachCommand`, after `env -u TMUX`, in a new
terminal on the same host and account:

```sh
env -u TMUX <tmuxAttachCommand>
```

When the daemon was started inside tmux on a non-default socket, its sessions live on that
server, and `tmuxAttachCommand` names it (`tmux -L <name> …` or `tmux -S <path> …`). The installing
agent fills in the actual command. This optional manual route
is separate from the first-install desktop action above.

### Plain terminal: a new viewing session

`SoftwareTeam terminal open saved:kernel --provider tmux --window --json` creates and opens
the same width-based SoftwareTeam view layout, with the advisor in a separate window. It reuses
the daemon's composition and preserves existing sessions. The result names the viewing session. No pane names or shell
commands need to be assembled by the person.

### Headless or SSH handoff

A provider running on the server opens no window on the person's desktop. From a new terminal window or tab on their
own machine, connect over SSH with the known host and account, then attach:
- **the operator's conversation**, with the command in
  [Talk to the operator in any terminal](#talk-to-the-operator-in-any-terminal);
- **the Herdr view**, with the command that `SoftwareTeam terminal open saved:kernel --window` prints when it can't open a
  window. It names the installed Herdr, wherever setup put it, and the daemon's socket. Then
  `SoftwareTeam terminal open saved:kernel --provider herdr --json` selects the view in it.

No new account or credential provisioning is part of this. **Agents:** the `SoftwareTeams` skill gives the person this as one
filled-in command.

### Installing-agent handoff

The kernel's operator takes the person's goal and project folder, helps them choose and start a team, and hands the
goal to the team's lead. The person can type the goal in the operator's pane (attach with the command
[above](#talk-to-the-operator-in-any-terminal)), or the agent that installed SoftwareTeam sends it. The `SoftwareTeam tui --shared`
fallback shows the dashboard, not this conversation. If the operator needs attention, use the
[recovery routes](#incomplete-setup-and-restart).

**Agents:** the `SoftwareTeams` skill's step 2 has the exact `SoftwareTeam send` to the operator and says when installation is finished.

Stopping SoftwareTeam keeps a team's work, and the branch a team makes is your
change: an agent tidying up says what's on it before offering to remove it. The
operator starts a team when you ask for one in its conversation, so an agent
reporting back checks `SoftwareTeam ps` or the team's tasks before saying a team started
on its own.

## Choose your first team

Tell the kernel operator what you want to do. It asks about your goal, presents
three teams with one recommendation, and fits the team to the providers you have.
Review that choice before launching it.

`SoftwareTeam specs preview starter --kind SoftwareTeam` and the factory preview include the three
choices and their uses, in text and JSON. The reminder respects a team you already
picked; previewing a spec does not launch it.

| Team | Talk to | Agents and purpose |
| --- | --- | --- |
| `starter` | `dev-build@starter` | `dev-build` (Claude Code) and `dev-review` (Codex, pinned `gpt-6-astra`) for one bounded change |
| `workshop` | `orch-lead@workshop` | A lead, builder, QA and reviewer for ongoing work in one repository. It's a SoftwareTeam bundle, not built in: the operator installs it from its pinned listing |
| `factory` | `orch-lead@factory` | Seven: a lead, advisor, build, QA, design and two independent reviewers for sustained product work. It uses the most concurrent capacity |

As shipped, `starter` needs both Claude Code and Codex. With only one of them, the
operator writes an adapted copy of the team for your providers and keeps its name;
there are no per-provider variants. `first-project` is starter's old name and
still starts it, so an old `SoftwareTeam up first-project` now starts a Claude builder and a
Codex reviewer. If you already have a SoftwareTeam named `first-project` (or `starter`),
`SoftwareTeam up first-project` refuses instead and names the `SoftwareTeam up <name> --existing`
command that brings that SoftwareTeam back.

Claude seats use the native default model, as the Claude kernel does: SoftwareTeam
does not pass a model override. Read the selected harness's configured model and
show it alongside the team and launch command before proceeding. Confirm account access to any pin; if unavailable,
ask for a supported model choice rather than silently substituting a model or
provider. After launch, confirm the actual native model before assigning work.

### Launch the starter team

```sh
cd <your-repository>
SoftwareTeam specs preview starter --kind SoftwareTeam
SoftwareTeam up starter --cwd . --plan
SoftwareTeam up starter --cwd .
SoftwareTeam status
SoftwareTeam ps --nodes --software-team starter
```

Preview the selected seats, models and resources. Plan checks resolution and
preflight for the working directory. The kernel is already your entry point; this step starts the chosen project
team. Read readiness for the project seats, not only daemon health. Resolve a named authentication, trust or permission prompt before giving
that seat work. When a seat stops at such a prompt, `SoftwareTeam up` reports
`Status: partial`, prints `Startup attention (<seat>): <reason>` and exits 1;
`SoftwareTeam ps --nodes` repeats it as "Startup details". The reason ends with the command
to run once the prompt is answered: `SoftwareTeam seat continue <seat>`, which delivers the
seat's startup context in the same conversation. No new team is needed when
returning to an existing project.

When a seat pauses, open its existing terminal with **o** in the startup view.
Read the proposed command, working directory and target instance. For an intended
local `SoftwareTeam` call, choose the native prompt's one-time approval if that is the scope
you want; a saved command-prefix allowance also affects future matching calls.
Decline an unexpected operation and tell the same agent what to do instead.
Approval controls whether an action may run; the sandbox controls its filesystem
and network access. Turning approvals off does not grant network access.

After answering, watch for the command's result and the agent continuing. Read
the corresponding task and its history from your ordinary terminal. If an
operation timed out, read its result before asking for another attempt: it may
already have taken effect. A delivered message or disappearing prompt alone is
not progress. If startup is still waiting for context delivery, use **c** (or
`SoftwareTeam seat continue <seat>`) for the same occupant, then **r** to refresh. If the
command times out, check `SoftwareTeam seat status <seat>` before trying again. Do not
start another seat to clear a prompt.

Starter is a deliberately small starting point. For a bigger team, `factory` is
built in (seven agents, using more concurrent capacity), and so are the specialist
teams `code-review`, `research` and `pm`. Inspect `SoftwareTeam specs ls --kind SoftwareTeam` and
`SoftwareTeam specs preview <name> --kind SoftwareTeam` before selecting one (`pm` is also an agent
spec's name, so a preview without `--kind SoftwareTeam` reports it as ambiguous). A team published on GitHub, such
as workshop, installs from its folder link with `SoftwareTeam up <link>` (see
[publishing a SoftwareTeam bundle](publishing-a-software-team-bundle.md)).

## Give the builder an outcome

For example, in a project that imports CSV files:

```sh
SoftwareTeam send dev-build@starter 'Improve the CSV import error when a required column is missing: name the column and leave the existing data unchanged. Add a regression check, ask dev-review for an independent check of the exact candidate, and record the result and how I can try it. Keep the change local; do not publish.'
```

Replace the example with a real problem in your repository. Include what the
user should observe, a boundary and how success can be checked. The builder
creates and claims a durable task, implements it, and routes the selected
independent check. You should not have to relay the review between terminals.
`SoftwareTeam send` is the initial conversation; the queue and repository artifacts
retain the work. An unbound shell does not need to impersonate a queue owner.

Seat addresses carry the SoftwareTeam name (for example, `dev-build@starter`). From an
actual project seat, follow the work with
`SoftwareTeam queue list --limit 1000`: its default scope is the caller's current SoftwareTeam.
`queue list` has no `--software-team` option. From an observer shell or another SoftwareTeam, use
`SoftwareTeam queue list --destination dev-build@starter --limit 1000` and the same
command for `dev-review@starter`, after verifying those live addresses.
These show each destination's obligations, not a whole-SoftwareTeam view. An unbound shell
must not pretend to be a seat to change scope; use `--all-SoftwareTeams` only when that
broader view is intended. Then read `SoftwareTeam queue show <id> --full` and
`SoftwareTeam queue transitions <id>`. A delivered message is not a reviewed result.
Read the artifact, exercise its behavior, and check the candidate reviewed.

## Share the dashboard and return to it

After install, and whenever the person wants their agents again, the installing agent runs
`SoftwareTeam terminal open saved:kernel --window` and checks the result. It does not
finish by suggesting a dashboard command for the person to type.

**Only if that window cannot open**, `SoftwareTeam tui --shared` is the dashboard-only
fallback. Explain the window failure and help with this fallback if chosen;
it does not show the advisor or operator conversation.

A fresh kernel runs the ordinary TUI in its existing `operator-human` terminal.
This command attaches another client to that terminal. **Ctrl-b, then d**
detaches without quitting the TUI; return with the same command and the view
stays where it was. Another authorized agent can capture or operate that same
pane. It should tell you before changing your view. The terminal is not a
human inbox and does not prove anyone is watching it.

Plain `SoftwareTeam tui` remains an independent local view. If an older kernel or a TUI
you quit shows a shell, run `SoftwareTeam tui` in that shell once. `--shared` does not
start or replace a terminal, so a missing binding is reported with recovery
guidance rather than creating a second kernel.

Herdr users follow the same launch and task path. To place the managed team in
Herdr, use `SoftwareTeam terminal open starter --provider herdr`; for the shared
dashboard together with the kernel conversations, use the
[saved first view](#open-the-kernel-conversations). The equivalent
cmux provider is also available. Read the opened/absent/degraded result: a
partial terminal view is not a healthy team. Repeated terminal-open calls can
create another provider workspace; return to the one already open when you
want to preserve it. This is terminal integration, not native plugin enrollment.

For team views with interactive panes, the open result distinguishes the dashboard
overview from the team's lead conversation and asks whether you can see the team.
This reminder is omitted from the default kernel view and entirely read-only watch
views. If the provider cannot open, each labelled fallback command joins a different
seat. Keep all returned commands
complete when sharing them; a created workspace alone does not confirm visibility.

## Continue real project work

Return to the same owner with the next outcome, citing the earlier result.
The seat address and durable queue survive closing your viewing terminal.
Keep intent, acceptance and evidence in the repository's existing project,
mission and slice artifacts; the starter reads those before inventing a path.
`SoftwareTeam context work-install` lists what the project declares (intent, context files,
skills). Without `--project` it picks the project by the seat's SoftwareTeam, then by the
working directory, and stops with `project_required` and the exact `--project`
commands only if several still match.

If the project has no work tree, start with `SoftwareTeam workspace doctor` and
`SoftwareTeam scope mission create --help`, then `SoftwareTeam scope slice create --help`. Set
the actual intended outcome before creating work. `SoftwareTeam scope` retains what is
being built. When repeated coordination warrants a workflow, discover with
`SoftwareTeam workflow specs`, inspect its owners and inputs, and instantiate the
selected name with `SoftwareTeam workflow instantiate --help`. A workflow is not needed
merely to make the first local change.

For a continuing team, [SoftwareTeam Software Factory](../../packages/daemon/specs/agents/shared/skills/core/softwareteam-software-factory/SKILL.md)
offers manual/team work, queue-supported orchestration without Workflow, and an
optional explicit Workflow path, with wake defaults, token costs and permission
choices visible. Give its short request to your existing agent. After
installation, discover the compatible bundled recipe with `SoftwareTeam context show
skills/core/softwareteam-software-factory --json`; retain a missing/version-mismatch
result rather than silently using newer instructions. Its growth section keeps
three choices clear: stay with the pair, add one or two seats to the running SoftwareTeam
with `SoftwareTeam grow` and no YAML, or optionally author a custom SoftwareTeam. It covers
new-seat context/work ownership, concurrency costs and saving the expanded spec.
This guide remains the short first-use path.

## Stop your teams

`SoftwareTeam down <software-team-name>` ends that SoftwareTeam's agent sessions and work in progress.
Read `SoftwareTeam ps --nodes --software-team <software-team-name>` first so you can see who will stop;
`SoftwareTeam down` also prints the SoftwareTeam's recorded agent sessions and their activity
before stopping them.
For example, to stop starter:

```sh
SoftwareTeam down starter
```

For "stop everything", list the SoftwareTeams with `SoftwareTeam ps --json` and run `SoftwareTeam down`
for each one you want stopped. Include `kernel` last if you want its operator,
advisor and queue worker stopped too; its operator cannot continue helping
after its own session ends. Check each result before calling the shutdown done.

`SoftwareTeam daemon stop` stops only the background service and preserves agent tmux
sessions. If you also want that service stopped, run it after stopping the SoftwareTeams.
If the operator is handling this full shutdown and kernel is included, it gives you this
last step before running `SoftwareTeam down kernel`: once kernel is down, run
`SoftwareTeam daemon stop` in your own shell and check the result. The operator's session
ends with kernel, so it cannot run that final command for you afterwards.
If the daemon is already stopped, use `SoftwareTeam daemon start --no-kernel` to restore
the lifecycle API without booting a new kernel, then stop the remaining SoftwareTeams.

## Incomplete setup and restart

| Observation | Next action |
| --- | --- |
| Tool missing or login fails | Use the specific setup/auth hint; recheck that executable in the launch shell. Do not send work to an unready seat. |
| "Startup attention" or "Startup details" names a prompt | Answer the login, trust or bypass prompt in that seat's terminal, then run the `SoftwareTeam seat continue <seat>` it shows. |
| "Readiness timeout after 30s — harness did not become interactive" | The harness took longer than the readiness window. Raise it for the next launch with `SoftwareTeam config set runtime.readiness_timeout_seconds <1-600>`, then relaunch that seat. |
| "Claude resume did not finish within Ns; Claude may still be starting, so the launch was kept" | A restored Claude seat was not interactive when the wait ended. Its pane and resume token are kept. Look at the pane; once Claude is up, run `SoftwareTeam seat clear-attention <seat>`. The wait is about `runtime.readiness_timeout_seconds` in total for each seat (default 30 s), counting the first 3.2 s, and the time adds up seat by seat in a restore. Raising the setting for slow fresh launches lengthens it. If `SoftwareTeam up` or `SoftwareTeam launch` times out at 120 s, that is not a rollback: check `SoftwareTeam ps` before running it again. |
| Daemon is healthy, kernel is still starting | Read `SoftwareTeam status` and `SoftwareTeam ps --nodes --software-team kernel`; kernel readiness is separate. |
| Kernel seats fail within a second of the first start, and tmux reports "server exited unexpectedly" | Check that your tmux can capture a pane, then start the failed seats again; see the tmux check below this table. |
| Shared terminal is absent | Inspect the existing kernel binding and recovery state; use standalone `SoftwareTeam tui` while resolving it. |
| Viewing terminal was closed | Open the conversations again with `SoftwareTeam terminal open saved:kernel --window`; `SoftwareTeam tui --shared` is only the dashboard fallback if that window cannot open. Do not relaunch the team. |
| Daemon restarted but tmux survived | Re-read `SoftwareTeam status` and the existing queue; a daemon restart is not a fresh project. |
| Host reboot lost tmux sessions | Open `SoftwareTeam`, start the daemon if needed (press **S** if it opens on the work views), and select the existing SoftwareTeam and seats. Resume is the default; a fresh conversation needs a separate decision. |
| Launch reports no usable snapshot | Inspect the existing SoftwareTeam and retained project files, then follow the same-seat recovery below. |
| Work is waiting on a prompt or decision | Read the row, transition and named prompt; preserve the obligation until the missing decision arrives. |

**When the kernel's seats all fail at the first start.** A report on Oracle Linux 10
([#980](https://github.com/mvschwarz/openrig/issues/980)) traced this to the distribution's packaged tmux, whose
`tmux -V` prints `next-3.4`: its server exited on every `capture-pane -p`, also outside SoftwareTeam. To check your tmux on
a throwaway socket, without touching your own sessions:

```sh
tmux -L "softwareteam-check-$$" -f /dev/null new-session -d -s check
tmux -L "softwareteam-check-$$" capture-pane -p -t check >/dev/null && echo "capture-pane works"
tmux -L "softwareteam-check-$$" kill-server
```

If the second command fails because the server exited, put a tmux that passes this check first on your `PATH`; the
reporter built tmux 3.5a into `/usr/local/bin`. Then, from a shell where `tmux -V` shows that tmux, restart the daemon
and start the failed seats again, as the reporter did:

```sh
SoftwareTeam daemon stop
SoftwareTeam start --last
SoftwareTeam ps --nodes --software-team kernel --full   # the failed seats show "failed" under STARTUP
SoftwareTeam up kernel --existing --fresh <failed seats> --yes
```

This recovery is for the case the reporter hit: the kernel's seats failed and none of them is still running.
`SoftwareTeam up kernel --existing` refuses a kernel that still has a live session. Name the failed seats by their logical
IDs, for example `advisor.lead operator.agent operator.human queue.worker` when all four failed. `--fresh` starts a
new conversation for each seat you name. Seats you don't name follow their normal recovery policy and may remain
awaiting a decision if their old conversation can't be resumed. A later `SoftwareTeam daemon start` doesn't retry the failed
seats by itself: once a kernel exists, startup skips the built-in kernel boot, and `SoftwareTeam status` then reads
`Kernel: skipped` whatever its seats' state, so check `SoftwareTeam ps --nodes --software-team kernel --full`.

If a snapshot is unavailable, the startup view checks the selected seat's
retained startup source and authoritative occupant relation. It reports a
missing or ambiguous source instead of selecting an arbitrary historical row.
Repair the named source, retry, or leave the seat stopped. Check the retained
queue, project notes and observed result before continuing work.

`SoftwareTeam setup` prints the short form of this path after ready, incomplete and dry-run
results; JSON output includes it as `nextSteps`. This guidance does not mean the
kernel is ready: retain any named failures, check the actual seat state, then
offer `SoftwareTeam terminal open saved:kernel --window`. If the person chooses a manual
attachment after a failure, derive the exact command from the current operator
binding [above](#talk-to-the-operator-in-any-terminal); not every failure prints
one. Hand the goal and project folder to the ready
operator rather than implementing the project during installation. `SoftwareTeam status`
points back here while no SoftwareTeams are registered.

### Use the startup and work TUI

Type `SoftwareTeam` in an ordinary terminal to open the startup and work TUI. It shows
the daemon address; **d** expands the selected instance path and diagnostics.
If the daemon is stopped, press Enter
to start that daemon, then choose the SoftwareTeams and seats you want. Kernel is
recommended first; selecting its operator does not start every kernel seat.
The same view is available with **S** from ordinary TUI work.
**?** opens Help even while connection checks are pending. **w** skips startup;
**Esc** goes back, or leaves startup from its first page. These choices do not
start a daemon or a seat. **L** opens local reading before or after connecting:
choose configured Specs, project intent, projects, or missions and slices, then
select a directory or file. **r** reads the selected source again; **Esc** returns.
Local reading uses this machine's configured workspace paths and file allowlist,
including when the selected daemon address is remote. It shows disk provenance,
missing or denied sources, binary files and the 1 MiB text truncation boundary.
These disk snapshots may change after reading and do not supply live queue,
execution or topology state. Once connected, the TUI opens the ordinary work
views by itself unless you have already pressed a key; **S** returns to startup.
A stalled live read does not prevent Help or local reading.
When terminal transport is unavailable, **t** starts the empty terminal service
so recovery choices can be inspected. It launches no seats.

For a previously occupied seat, Enter attempts its previous conversation.
If history is unavailable, read the reason. **f** opens a separate fresh-start
decision for that named seat; **Esc** declines without launching it. A confirmed
fresh conversation receives the configured context and retains the old history,
but does not resume that history. Authentication or runtime failures require
repair of that prerequisite. **o** opens the existing native terminal here; detach
to return (tmux defaults to Ctrl-b, then d). Decide native trust/auth prompts
there. If a fresh start paused before context delivery, **c** finishes that
delivery to the same occupant (from a shell, `SoftwareTeam seat continue <seat>` does the
same). **r** reads actual state again; **d** expands details.

## Kernel framing (what `SoftwareTeam setup` does and does not do)

Explicit CLI daemon startup retains its automatic kernel behavior. The TUI
starts the daemon with kernel auto-boot disabled so the user can select seats:

- `SoftwareTeam setup` installs/verifies the runtime; it does not start the daemon or the
  kernel.
- Starting the daemon (`SoftwareTeam daemon start`, or implicitly via `SoftwareTeam up` or `SoftwareTeam context add`) is what
  boots the kernel SoftwareTeam in the background.
- Starting it from bare `SoftwareTeam` prepares no agents automatically. The TUI offers
  kernel setup and individual seat selection after connecting.
- **Kernel readiness is a distinct signal from daemon health.** The daemon's HTTP
  health binds early; the kernel can still be booting or a kernel agent can be
  unhealthy while the daemon is up. `SoftwareTeam status` surfaces kernel readiness
  separately (via `/api/kernel/status`); `SoftwareTeam daemon start --wait-for-kernel`
  polls it.

## The scope <-> workflow bridge

Two related primitives, often confused by new operators:

- **`SoftwareTeam scope`** manages **durable, on-disk artifacts** - missions and slices
  (markdown/YAML files in your workspace). These are the persistent record of
  *what work exists*.
- **`SoftwareTeam workflow`** manages a **runtime instance** - when you
  `SoftwareTeam workflow instantiate <name>`, the daemon creates a workflow instance plus
  an **entry qitem** that routes the first step to an owner. This is the live
  coordination of *who does the next step*.

Scope files retain what the work is; workflow instances and their queue packets
retain who acts next. Creating or editing a mission does not start work. You can
instantiate a named workflow with `SoftwareTeam workflow instantiate <name> --root-objective <text> --created-by <session>` (both options are needed), or explicitly
inspect an authored lifecycle with `SoftwareTeam workflow compile` and create its runtime
with `SoftwareTeam workflow instantiate-lifecycle`. Compilation alone does not start work.
[SoftwareTeam Software Factory](../../packages/daemon/specs/agents/shared/skills/core/softwareteam-software-factory/SKILL.md)
shows a small reviewed example and how to retain custody through a genuine wait.

## Have your agent configure permissions

For a team with no permission policy, your agent recommends keeping the
[team default](software-team-spec.md#team-launch-defaults), unless you already made an
explicit choice for these harnesses and this scope. It offers additional
remembered allowances only if you want them:

> Remember these selected SoftwareTeam commands in your native settings for this
> project? This is separate from the team launch default; stricter rules and
> Claude lifecycle asks remain. **Yes / No — keep the team default**

A remembered allowance can cover the whole `SoftwareTeam` family, but on Claude team
seats lifecycle commands such as `SoftwareTeam up` and `SoftwareTeam down` still ask. It is not
global YOLO or permission to invent work. The scope is your personal settings
for this project unless you explicitly choose user-wide sessions, which can
affect your other projects.

On an actual **Yes**, the agent backs up the relevant files, adds the existing
native rules without duplicates, and preserves stricter rules and unrelated
settings. It checks bare and actual absolute-path invocations, rule loading and
repeated harmless reads in the target conversation. No or no answer leaves
settings alone and keeps the team default. Unsupported scope or a
managed restriction is reported; it is not permission to grant broader access.

The agent remembers an explicit choice, scope and exact additions in existing
onboarding context, so setup does not ask again. You do not need to approve each
routine edit separately. To undo, say **“Undo the SoftwareTeam command allowances
added by this setup; keep my other rules.”** The agent removes only its recorded
additions, preserves earlier rules and later edits, and verifies reloading.
Other pre-existing allowances may still permit commands after this undo.

Use the maintained **Applying a permission policy** procedure:

```sh
SoftwareTeam context get skills/applying-a-permission-policy/SKILL.md
```

In a source checkout, read [its source](../../packages/daemon/assets/plugins/softwareteam-core/skills/applying-a-permission-policy/SKILL.md).
In an npm installation, the same file is under
`@softwareteam/cli/daemon/assets/plugins/softwareteam-core/skills/applying-a-permission-policy/SKILL.md`
below the matching `npm root -g` or local `npm root`. Use the version supplying
your `SoftwareTeam` executable. It covers Codex/Claude command rules, actual config roots,
preserving restrictions and verifying the target conversation. A missing guide or
unsupported native version is a reported gap, not permission to silently bypass.

The broader launch-mode recipes below are optional. Command-family rules do not
require changing the starter's sandbox or everyone else's defaults.

## Opt-in permissive operation

Permissive operation lets agents act with your account's filesystem and network
access with fewer permission stops. They can damage files or send data without
another confirmation. Use it only for work and an environment you deliberately
trust; it does not supply missing credentials or override organization policy.

Make changes in a **user-owned spec before its first launch**. To customize the
starter, run `SoftwareTeam specs show starter --kind SoftwareTeam` and find its `Path`, ending
in `specs/SoftwareTeams/launch/starter/software-team.yaml`. Copy that whole `specs` directory to
`./softwareteam-specs` in your repository, keeping its layout: copying only `software-team.yaml`
breaks its relative agent and culture references. Leave the installed copy alone.
The examples below use `./softwareteam-specs/SoftwareTeams/launch/starter/software-team.yaml`. If you
already have a running `starter`, follow the existing-session advice below
before changing it; this is not a live permission switch.

### Codex: select sandbox and approvals together

For Codex versions supporting named `.config.toml` profiles, create
`~/.codex/starter-permissive.config.toml` (under `CODEX_HOME` instead if you
set it for the daemon's launch environment):

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

In the copied SoftwareTeam, add this field to **each Codex member** that should use it (in
starter, that's `dev.review`); keep the member's existing `profile: default`:

```yaml
codex_config_profile: starter-permissive
```

Leave `permission_policy` absent or set it to `none`, with no member-level YOLO
override. SoftwareTeam then passes `-p starter-permissive` instead of its default
`-s workspace-write`, so the native profile supplies both settings. Higher-priority
native project configuration or managed requirements can still change/refuse the
result. Inspect native `/status` before assigning work.

```sh
SoftwareTeam policy current --spec ./softwareteam-specs/SoftwareTeams/launch/starter/software-team.yaml
SoftwareTeam up ./softwareteam-specs/SoftwareTeams/launch/starter/software-team.yaml --cwd . --plan
SoftwareTeam up ./softwareteam-specs/SoftwareTeams/launch/starter/software-team.yaml --cwd .
```

SoftwareTeam's `permission_policy: builtin:yolo` setting selects
`-s danger-full-access -a never` on fresh, resume and fork launches, replacing
the named-profile argument. The profile recipe above remains useful when you
want to maintain those choices in native configuration. The legacy
environment-only `SOFTWARETEAM_YOLO=1` path remains sandbox-only when no resolved
policy is present. A standalone `codex --yolo` command is not an SoftwareTeam setting.
At full access, Codex can show its full-access and GPT-5.1 migration notices at
first launch. When SoftwareTeam itself selects full bypass for the seat (`builtin:yolo`,
a `full_bypass` flag policy, or an explicit seat `full_bypass`), `SoftwareTeam up <spec> --non-interruptive` hides them
with per-launch `-c` overrides (see [non-interruptive mode](non-interruptive-mode.md)).
Full access chosen inside a native Codex profile, with `permission_policy` absent or
`none`, doesn't qualify.

To return to a restricted next launch, change the selected profile to:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

### Per-seat permission mode

Permission mode is the native execution choice; work posture is project guidance.
For an existing managed seat, select future-launch permissions explicitly:

```sh
SoftwareTeam seat set-permissions dev-build@starter --mode full_bypass --reason "Operator selected broader access"
SoftwareTeam seat status dev-build@starter --json
```

This records the actor, reason and old/new choice on that seat. It does not
relaunch it, alter native history, change sibling seats, or edit permission
rules/hooks. A later lifecycle action remains a separate decision. The explicit
seat choice overrides the inherited member/SoftwareTeam policy; `--mode inherit` clears
it without changing that inherited policy. `floor` selects the existing normal
launch path (including a Codex named profile when configured); it does not
rewrite a native profile or force its approval settings. An explicit `floor`
also replaces any team or kernel launch default with the plain floor flags;
`inherit` brings the default back.

Codex and Claude accept `floor` and `full_bypass`. Additional Claude native modes,
including `auto`, require support advertised by the managed executable's help.
SoftwareTeam resolves the first executable on its managed launch PATH at the seat's
absolute working directory, then uses that exact path for discovery and launch.
It does not use interactive shell aliases or a shell's modified PATH. Relative
PATH entries and a relative `CLAUDE_CONFIG_DIR` resolve from the seat directory.

For these explicit native modes, fresh, resume, fork and legacy restore use the
same managed environment: PATH, HOME, `CLAUDE_CONFIG_DIR` (default HOME/.claude)
and the configured classic-renderer setting. Other shell customizations are
excluded. The existing managed identity and allowlisted provider-auth channel
is retained by variable name; credentials are not copied into launch commands
or capability evidence. Help runs without that credential channel. Existing
login files remain under the managed home. Configure the daemon's managed
launch environment deliberately before selecting a mode; this is not a probe
of an arbitrary interactive shell.

Each selection and each later launch checks support again, without a cache.
A changed node/occupant, binding, cwd, executable or capability environment
refuses at the next check: after help, before selection/audit mutation, and
immediately before paste and Enter. A failure after a valid paste is partial
input, not a successful launch or a claim that earlier input was rolled back.
An existing explicit selection is retained on refusal; no fallback is chosen.
Ordinary and inherited launch paths are unchanged. The status response
distinguishes desired settings, generation-bound
launch arguments and an unverified native effect. Inspect the native session
after an authorized launch before claiming its actual permission behavior.

The software-team-level verbs are `SoftwareTeam policy permissions list`, `show`, `current` and
`apply`. Existing `SoftwareTeam policy list/show/current/apply` remain compatibility
aliases with the same JSON and exit behavior. Pi resource trust and the per-seat
typing guard are separate controls.

### Claude Code: a different launch flag

In the shipped `starter`, `dev-build` runs Claude Code. For a **Claude Code** seat,
SoftwareTeam normally passes `--permission-mode acceptEdits`: edits can proceed, while
other actions follow native rules and prompts. For a seat with no permission
policy or per-seat choice it also passes the per-launch team default (`--settings` allowing ordinary
`SoftwareTeam` commands, project reads and common tests, with a session hook asking for
lifecycle commands while allowing literal help forms such as `SoftwareTeam down --help`);
personal and project rules still apply. Nothing is written to your settings files. To explicitly select the bypass launch flag for that SoftwareTeam:

```sh
SoftwareTeam policy apply yolo --spec ./my-claude-SoftwareTeam/software-team.yaml
SoftwareTeam policy current --spec ./my-claude-SoftwareTeam/software-team.yaml
```

This records `permission_policy: builtin:yolo`; the next managed launch passes
`--dangerously-skip-permissions`. Member-level policies take precedence.

On a machine where nobody has accepted it yet, Claude Code then shows its
bypass-permissions warning in each new seat, and SoftwareTeam reports the seat as
needing attention without sending its startup context. Either accept the warning
once beforehand (run `claude --dangerously-skip-permissions` in your repository,
accept, then `/exit`; Claude Code remembers it), or accept it in the seat and run
`SoftwareTeam seat continue <seat>`. Or launch with `SoftwareTeam up <spec> --non-interruptive`,
which accepts it with a launch flag and writes nothing to your settings; see
[non-interruptive mode](non-interruptive-mode.md).

`SoftwareTeam policy apply auto --spec ./my-claude-SoftwareTeam/software-team.yaml` (also `SoftwareTeam setup --policy
auto --spec ./my-claude-SoftwareTeam/software-team.yaml`) records `builtin:auto` instead: Claude seats launch with
`--permission-mode auto`, and Codex and Pi seats, which have no auto mode, launch
at the floor. To return future launches to the team default, remove
`permission_policy` from the spec along with any member-level bypass override.
`SoftwareTeam policy apply none --spec ./my-claude-SoftwareTeam/software-team.yaml` instead records plain
`acceptEdits` without the team allowances. Native rules
and managed restrictions still matter; this flag is not a promise about sandbox
or account access. See [Claude permissions](https://code.claude.com/docs/en/permissions).

**Already running:** changing a file or running `SoftwareTeam policy apply` does not revoke
a live agent's permissions, and a spec edit does not rewrite a stored SoftwareTeam's policy
on restore: restore and resume read each seat's stored policy. To change that
for an existing seat, run `SoftwareTeam policy apply <name> --seat <seat> --reason <text>`,
adding `--operator <address>` outside a managed seat. Restore, resume and launches
that read the seat's stored state then use it, unless an explicit native selection
(`SoftwareTeam seat set-permissions`) takes precedence; the running process and the spec
file are unchanged. `SoftwareTeam up <SoftwareTeam name>` uses it, while launching from a spec that
declares a policy replaces it with the spec's policy, which later restores then
use. `--seat none` is an explicit floor for that seat, not "no policy", and it does
not inherit the SoftwareTeam's policy. After `--seat`, a `SoftwareTeam launch --retry-startup-from`
file has to carry the new policy. Pause
work and use the native permission controls for that conversation (current
Codex and Claude CLIs expose `/permissions`); inspect the effective mode again.
Keep the launch spec/profile consistent for subsequent launches. If the native
version cannot apply the change in place, preserve the work and use the supported
same-seat stop/resume path after checking its retained policy; do not erase the
SoftwareTeam or start a duplicate to reset permissions. A resume can reapply the stored
launch mode, so verify the native mode again before continuing work.

## Custom settings and precedence

- **SoftwareTeam:** member `permission_policy` overrides SoftwareTeam `permission_policy`.
  Normal managed launches bind the default mode explicitly when neither is set;
  exporting `SOFTWARETEAM_YOLO=1` in a client shell is not a reliable per-team recipe.
  A custom policy file is relative to the declaring SoftwareTeam spec, with no absolute
  path or `..`. `surface: flag` selects a launch mode. Config-surface policies
  (`locked`, `standard`, `open`, or custom) describe intent: recording one does
  not translate and enforce its rules. Apply and inspect the actual native
  settings separately. See [SoftwareTeamSpec policy references](software-team-spec.md#attaching-a-permission-policy).
- **Codex:** personal settings live in `~/.codex/config.toml` or `CODEX_HOME`;
  trusted project settings live in `.codex/config.toml`. Current precedence is
  CLI overrides, trusted project settings, selected profile, user settings,
  cloud defaults when supplied, `/etc/codex/config.toml` on Unix, then built-in
  defaults, subject to managed requirements. SoftwareTeam's explicit sandbox flag
  wins over a file's `sandbox_mode`; use `codex_config_profile` for a custom
  sandbox instead. For workspace edits with network access while retaining
  approvals, use a named profile with `sandbox_mode = "workspace-write"`,
  `approval_policy = "on-request"` and `[sandbox_workspace_write]`
  `network_access = true`. That grants network access generally, not just to
  the local daemon. See [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [sandbox/approval controls](https://learn.chatgpt.com/docs/agent-approvals-security).
- **Claude Code:** use `~/.claude/settings.json`, shared project
  `.claude/settings.json`, or personal project `.claude/settings.local.json`.
  Managed settings precede launch flags, then project-local, project-shared and
  user settings. Permission-rule lists combine; a higher-level allow is not a
  way to defeat a deny. SoftwareTeam's `acceptEdits` launch flag overrides a file's
  `permissions.defaultMode`; selected runtime resources may also merge into
  project-local settings. See [Claude settings and precedence](https://code.claude.com/docs/en/settings)
  and [SoftwareTeam's runtime config disclosure](agent-startup-guide.md#runtime-config-disclosure).

These recipes do not establish every provider/version/config combination.
Check the installed version and effective settings. Newer permission-profile or
automatic review features are provider choices, not implicit SoftwareTeam capabilities.
Selecting rules or a broader mode does not change the shipped defaults.
