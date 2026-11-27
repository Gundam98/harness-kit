# CI adoption: a diff check without a base, and CI configs as Harness paths

Date: 2026-11-27 (0.9.1, together with the git version and config isolation fixes)

## Problems

Both were found while wiring `harness-kit ci` into downstream CI.

1. **A base-less `git diff --check` passes in CI without checking anything.** Without a revision, `git diff --check` compares the worktree with the index. A CI checkout is clean, so it never finds anything; locally it never sees committed task changes either. doctor said nothing, and upgrade did not touch it.
   - Where the command came from: not from `init`. diff_check entered the init starter in 0.7.2 already as `git diff --check ${HARNESS_KIT_BASE:-HEAD}`, and git history has no base-less template. The base-less form in downstream manifests was written by hand during adoption.
2. **Pipeline files show up as `unmapped-file`.** After adding the job from `examples/ci/`, every change to `.github/workflows/<name>.yml` or `.gitlab-ci.yml` gave plan-checks and deliver an `unmapped-file` advisory. `.agents/**` and the hook client configs are Harness paths; the file that runs the CI gate was not.

## Decisions

1. **Recognize a diff check without a base.** `diffCheckWithoutBase` (src/diff-check.ts) flags a `git diff ... --check` whose arguments before `--` contain no revision, or only `HEAD`. `--cached`, git's own options (`-C dir`, `--no-pager`) and `cmd && git diff --check` chains are covered. Anything it cannot read (a variable, a command substitution, a range, a path pair) counts as a base, so it never flags a command that may be right.
   - doctor gives a WARN with the fix, next to the other vacuous pass (an enforcement glob that matches 0 files).
   - `ci` adds it to a new `warnings` list (text output and JSON) when such a check is among the selected ones.
   - The onboarding skill says to write the base into whitespace checks.
   - Not an error, and ci does not fail on it: the check belongs to the repository, upgrade fixes the common form (decision 2), and failing would turn every such merge gate red on the version bump for something no change caused. The warning puts it in the job log next to the green result.
2. **upgrade migrates the exact old value.** New migration `diff-check-task-base-v1`: a capability whose `run` is exactly `git diff --check` becomes `git diff --check ${HARNESS_KIT_BASE:-HEAD}` (the value init writes), keeping the quote style; a plain scalar becomes double-quoted, because `{`, `}` and `:` are unsafe inside a flow mapping. Each rewrite is a note in the report. Any other base-less form (for example `git diff --check -- src`) was written for a reason, so upgrade leaves it and says so in a note.
   - Why migrate a hand-written value at all: this exact command has one meaning, and the rewrite only widens what it checks. Under run-checks and ci it diffs the judged base; elsewhere `${HARNESS_KIT_BASE:-HEAD}` falls back to the old worktree-against-HEAD comparison. What can newly fail is a whitespace error inside the change itself, which is what the check claims to catch.
   - The migration framework is now text in, text out. A migration edits only the YAML nodes it owns (by their source range), so comments and layout of the hand-authored manifest stay. The old contract handed migrations a YAML document model, and the first migration that changed anything would have re-serialized the whole file.
3. **`validation.ci_configs` declares the CI configs.** It is an optional list of exact, target-relative file paths: `.github/workflows/harness.yml`, `.gitlab-ci.yml`, or any other platform's pipeline file. It is not a list of platforms built into the tool.
   - The planner treats them as Harness paths: never unmapped or required-unmapped. A change made only of them needs no check (verify is their check), and `no_match` still applies when no module is affected.
   - verify keeps the declaration honest: each declared file must exist, and at least one of them must still call `harness-kit … ci`. The call is matched as text, so a workflow that calls a script passes when the script is declared too. Removing the gate fails verify.
   - doctor reports a declared path that is missing, and includes the declared files in its scan for pins that differ from the lock.
   - Exact paths, not globs: a workflow directory also holds release and deploy pipelines, and a glob would exempt them as well.
   - Not detection by content ("a file that mentions `harness-kit ci` is a Harness path"). That would need file reads in the pure planner, would silently exempt a pipeline file that also deploys, and nothing could check it. The declaration is reviewed in the manifest, and verify checks it.

## Verification

Published 0.9.0 as the baseline; this tree's build as 0.9.1:

- Fixture adopted with 0.9.0, with `diff_check: run: git diff --check`, and a feature branch that commits a trailing-whitespace line:
  - 0.9.0 `ci --base main`: passed, diff_check passed.
  - 0.9.1 `ci`: passed, with the warning in `warnings`; `doctor` WARNs with the fix.
- `upgrade --check`: exit 2, pending `diff-check-task-base-v1`, the manifest in `changedFiles`, and the rewrite note. `upgrade` then changes one line of the manifest (`run: git diff --check` → `run: "git diff --check ${HARNESS_KIT_BASE:-HEAD}"`); the comment above it stays.
- After the upgrade, `ci`: exit 1, diff_check failed on `src/core.ts:1: trailing whitespace`.
- The pipeline file: 0.9.0 reports it as `unmapped-file`. With `validation.ci_configs: [.github/workflows/harness.yml]`, 0.9.1 `ci` passes with no unmapped gap, and verify reports "runs harness-kit ci". With the gate removed from the file, verify fails.
- 0.9.0 reading the same manifest: no schema error; it ignores the field and reports the old advisory.

## Compatibility and upgrade

- **Manifest schema.** One optional field, `validation.ci_configs`. Nothing was removed or changed in meaning, so the manifest-schema contract (`breaking_needs: major`) does not apply. Older CLIs do not reject unknown keys: they ignore the field and keep reporting the pipeline file as `unmapped-file`, and the lock pins the version anyway.
- **upgrade.** The lock's `appliedMigrations` gains `diff-check-task-base-v1`. A repository whose diff check is exactly `git diff --check` gets the manifest rewritten in the same transaction as the lock and generated files. Its CI can then fail on whitespace errors it used to skip: that is the check starting to work, not a regression.
- **ci-report/v1.** Additive: `warnings`.
- **Version.** Still 0.9.1 (patch): no CLI flag, command or JSON field changed or was removed in this part, and the schema change is additive.
- **Upgrading a repository:**
  1. `upgrade --repo . --check`; the notes list any diff check upgrade rewrites or leaves alone.
  2. `upgrade --repo .` on a clean tree.
  3. Give each base-less check the notes name a base by hand.
  4. If CI runs `harness-kit ci`, add that file to `validation.ci_configs`, then `sync` and `verify`.
  5. Commit.
