# Publishing a SoftwareTeam bundle

A SoftwareTeam bundle is a whole SoftwareTeam team that someone else can install and run: the SoftwareTeam spec, its agents, their
instructions and skills, and its documentation. This guide walks through building one, checking it, sharing it as a
link and installing from a link. The last section is a block of instructions you can
give your agent to build one for you.

For every flag, see the [SoftwareTeam bundle reference](software-team-bundle.md); for the file formats, see
[bundle formats](bundle-formats.md). This guide doesn't repeat them.

## 1. Lay out the folder

A shareable bundle is one folder, kept on GitHub: in its own repository, or as a subfolder of one you already have.
The folder holds the SoftwareTeam spec (`software-team.yaml`), the agents it uses, and a README. Choose
[names that describe the team, domains and roles](topology-naming.md) before wiring its references.
The rules are the bundle standard
(`softwareteam.bundle-standard/v1`), summarized under "Advisory author check" in the
[SoftwareTeam bundle reference](software-team-bundle.md#advisory-author-check).

Two rules matter most for strangers:
- **Keep everything inside the folder.** Every `agent_ref` should be `local:` and point inside it. A path that exists on
  your machine won't exist on anyone else's.
- **Never put credentials in it.** No tokens, keys or `.env` files. `SoftwareTeam bundle create` refuses well-known sensitive
  file names (such as `.env`, `.pem` and `.key`) anyway.

Two optional files sit beside `software-team.yaml`:
- **`bundle.yaml`** declares what people need before installing: setup steps (`preconditions`, shown before install
  and never run), the oldest SoftwareTeam that works (`compatibility.min_cli_version`), and skills shared by several
  agents.
- **`configurations.yaml`** offers other harness mixes (for example all-Claude), as presets. The recommended preset
  must be `software-team.yaml` as written. `SoftwareTeam bundle configurations ./my-team/software-team.yaml` lists them with their configuration
  IDs.

## 2. Check it

```sh
SoftwareTeam bundle check ./my-team                     # checks the folder against the standard; launches nothing
```

Fix what it reports, or say in your README why a finding doesn't apply. Any finding exits 1, and the output names the
file a finding is about when there is one. It checks the folder on disk, including files you haven't committed, so
check again at the commit you share. README completeness and embedded secrets always read `not_checked`: those are yours to review.

You can also build and look inside the archive:

```sh
SoftwareTeam bundle create ./my-team/software-team.yaml -o my-team.softwareteambundle --name my-team
SoftwareTeam bundle inspect my-team.softwareteambundle
```

`create` and `inspect` don't launch anything. A local build like this packages a minimum SoftwareTeam version only from
`--min-cli-version`; a build from your link reads it from your `bundle.yaml`. To preview what installing would do,
`SoftwareTeam bundle install my-team.softwareteambundle --plan` writes nothing to a target, but it isn't free of side effects: it records
a planned run, and it can run harness checks such as `pi --version` for Pi seats.

## 3. Share it as a link

Share a link to the folder **at a full commit**, so everyone gets exactly the version you checked:

```text
https://github.com/<you>/<repo>/tree/<commit>/<path-to-folder>
```

A branch name moves when you push again; a commit doesn't. `SoftwareTeam bundle inspect` on a branch link prints the
commit-pinned link to share (`Source:`). Use the full 40-character commit ID: a shorter one is looked up as a branch or
tag name and isn't found.

## 4. Install from a link

```sh
SoftwareTeam bundle inspect https://github.com/<you>/<repo>/tree/<commit>/<path>     # see what it will do first
SoftwareTeam up https://github.com/<you>/<repo>/tree/<commit>/<path> --target <an empty folder> --cwd <your project>
```

Look before you run. `inspect` shows which agents start and with what access, what they're told, what gets written
where, and what the bundle needs, including the author's setup steps. Its integrity check tells you the archive is
self-consistent; it doesn't tell you who made it. `SoftwareTeam up` prints the same view before it installs, but doesn't stop to
ask.

Links need `git`, a running local SoftwareTeam daemon, and a public GitHub link without credentials; they don't work with
`--host`. If the team uses `permission_policy: builtin:yolo` (no permission prompts), `--non-interruptive` lets SoftwareTeam accept the harnesses'
first-launch warnings for you (see [non-interruptive mode](non-interruptive-mode.md)). As the author, you can make that
the install default by declaring `non_interruptive: true` in `software-team.yaml`; `--no-non-interruptive` overrides it.

Installing writes the bundle's files into the install target (`--target`, the current directory if you leave it
out) and launches the team from there, with the seats working in `--cwd`. If the target already
has a different file at the same path, install refuses and writes nothing, so use an empty or dedicated directory.
Installing again over a stopped team of the same name replaces it, and in its own install folder the changed files are
backed up first under `~/.softwareteam/bundle-backups/`. A running team of the same name is refused, so stop it with
`SoftwareTeam down` first. The reference's "Install a bundle" section has the details.

## 5. Choose your harnesses (when a bundle offers configurations)

```sh
SoftwareTeam up <link> --preset all-claude
SoftwareTeam up <link> --seat orch.lead=pi --seat dev.qa=codex
```

Share the commit-pinned folder or local bundle artifact with its configuration ID,
package digest and honest test record. SoftwareTeam does not currently operate a
public registry or claim upstream registry acceptance. The original
[OpenRig registry](https://github.com/mvschwarz/openrig-registry) is an external
upstream service with its own compatibility and submission rules.

---

## Give this to your agent

> Build an SoftwareTeam SoftwareTeam bundle for: <one sentence on what the team should do>.
>
> Read the bundle guide and reference for the SoftwareTeam version installed here (`SoftwareTeam --version`): the installed copies
> are `publishing-a-software-team-bundle.md` and `software-team-bundle.md` in `$SOFTWARETEAM_HOME/reference/` (default `~/.softwareteam/reference/`).
> Follow the bundle standard in the reference:
> - one folder with `software-team.yaml`, a README listed in its `docs`, and every agent inside the folder, with each
>   `agent_ref` as `local:`;
> - no credentials, tokens or absolute paths anywhere in the folder.
>
> Run `SoftwareTeam bundle check <folder>` and fix every finding, or explain in the README why it doesn't apply.
>
> Preview with `SoftwareTeam bundle create <folder>/software-team.yaml -o <scratch>/team.softwareteambundle`, then `SoftwareTeam bundle install
> <scratch>/team.softwareteambundle --plan`. Don't launch the team for real unless I say so.
>
> When it's clean, show me the check output, the folder tree, and the README's sections on what to do before
> installing and on permissions. I decide whether to push it and submit it.
