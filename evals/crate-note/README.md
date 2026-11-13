# Crate note

Checks the one-line crate note a thread gets on its first turn in a member crate of a Cargo workspace ([`workspaceCrateNote.ts`](../../apps/server/src/workspace/workspaceCrateNote.ts)). With the note, an agent whose task needs a workspace dependency should open that dependency directly, not run `cargo tree` or search the whole workspace. On a task inside its crate, it should stay there.

The model gets the real note and the real first-message wrapper (`withInlineContext`), a small in-memory workspace, and `read_file`, `list_dir`, `search` and `run` tools. `run` never runs anything.

## Run

```sh
cd evals
pnpm crate-note --out runs/note
pnpm crate-note --out runs/no-note --note none
pnpm crate-note --out runs/sparse --sparse
pnpm crate-note --out runs/sparse-plain --sparse --note plain
```

- Models go through the `vibeproxy` provider in `~/.codex/config.toml`, as in [test-signal](../test-signal/). Defaults: `gpt-6.1-terra` and `gpt-6-luna`. Pass `--model` once per model.
- Flags: `--note current|plain|none` (`none` is the baseline without the note, `plain` the note without the sparse-worktree hint), `--sparse`, `--case <id>` (repeatable), `--samples <n>` (default 3), `--concurrency <n>` (default 6).
- `--sparse` hides what a sparse worktree of the crate leaves out: other crates' files except their manifest and target file. `run` starts in the crate's folder and follows `cd` and `git -C`; `git sparse-checkout add` brings a folder in only from the worktree root and otherwise prints git's non-cone error. Only sparse runs include `outside` cases, and naming one without `--sparse` is an error.
- A `dependency` case passes when the first file the agent touches outside its crate belongs to a dependency the note names, and it never asks cargo for the graph. A `local` case passes when it stays in its crate. An `outside` case passes when it reads its target file once the checkout holds it, and fails if it runs `git sparse-checkout disable`. A case passes on a majority of samples.
- `summary.md` lists passes and tokens per model and case. A full run is about 12 short conversations per model.

## Add a case

Add an entry to `cases.ts`, naming where it came from. A `dependency` case must fail with `--note none` on at least one model, and an `outside` case with `--sparse --note plain`.
