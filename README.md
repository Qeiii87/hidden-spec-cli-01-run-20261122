# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Qeiii87/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Qeiii87/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files, as the
specification in `SPEC.md` says. Models write edits in four formats — a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON — and mend reads each one as the
specification says, finds the lines each edit names at the first of three
matching tiers (exact, trailing-whitespace-insensitive, then
leading-and-trailing-whitespace-insensitive with re-indentation), and writes
every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` (or absent) to read it from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 prints
one line for a usage, no-patch, format or parse error. Standard error is never
compared.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as it is.
- `check.ts` — runs `main.ts` on the kit's public practice set:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract.

## Local checks

Practice set (100 checks, score out of 1000) and an edge-case suite built from
the specification's sentences:

    node check.ts ../hidden-spec-cli-01-run-20261122-kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
