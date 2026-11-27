# ci on an old git, and the checks' git config

Date: 2026-11-27 (0.9.1)

## Problems

Both were found while wiring `harness-kit ci` into downstream CI.

1. **An old git turned into a wrong verdict.** On a CI image with git 2.20, `ci` reported `no-merge-base: … share no history` (exit 2). The real cause was the git version: `merge-base` and `fetch` reject `--end-of-options` (it reached git's option parser in 2.24) with "unknown option" (exit 129). ci's helpers read every git failure as "no", so the rejected flag became "no common history". A scan of the other git calls on a real git 2.20 found more of the same kind:
   - `isLinkedGitWorktree` passed `rev-parse --path-format=absolute` (git 2.31). Older git prints the unknown flag as output, the path never matches, and **every** repository counted as a linked worktree: `install-hooks --stop` refused Codex in a plain repository on any git before 2.31.
   - `install-hooks --git` reads `git config --show-scope` (git 2.26) and failed with git's usage text.
   - deliver's task-base ancestry warning (`merge-base --is-ancestor --end-of-options`) disappeared without a word.
   - `rev-parse --verify --end-of-options` works on old git by accident: under `--verify` rev-parse ignores flags it does not know (it learned this one in 2.30). So change collection, and with it run-checks, verify, deliver's scope and the lifecycle hooks, works on 2.20.
2. **ci's fetch and its checks share one environment.** Some build machines carry `url.<base>.insteadOf` rewrites in the system or user (XDG) git config. ci's fetch needs them to reach the remote; a repository check that reads a remote URL must not see them. The only way out was to fetch outside and run `ci --no-fetch` in a different environment.

## Decisions

1. **git 2.24 is the minimum, checked where a feature needs it.** `GIT_REQUIRES` (src/git.ts) names each requirement and its feature: core 2.24 (`--end-of-options` for merge-base and fetch), configScope 2.26 (`git config --show-scope`), configGlobal 2.32 (`GIT_CONFIG_GLOBAL`). `gitVersionProblem` reads `git --version` of the git on `PATH`, the one every call runs. A version string it cannot parse (a vendor build) is accepted rather than refused on a guess; a git that does not run is `git-unavailable`.
   - `ci` checks before anything else. Too old is `git-unsupported`, exit 2, and the message names the required and the found version. The report gains `git.version`.
   - deliver's ancestry check turns the version problem into a task warning instead of dropping the warning.
   - `install-hooks --git` refuses with the requirement before it calls `--show-scope`.
   - `isLinkedGitWorktree` resolves `--git-common-dir` against the worktree root, as install-hooks already did, so it no longer needs 2.31 at all.
   - Other commands are not gated. They work on older git (above), and a gate would break working setups, lifecycle hooks included, for nothing.
   - The minimum is not lowered by dropping `--end-of-options`. It guards refs that come from CI variables (0.9.0 ADR, decision 3), and git 2.24 dates from 2019.
2. **A git failure is not "no".** In ci, `rev-parse --verify --quiet` and `merge-base` mean "no such commit" / "no common ancestor" only when they exit 1 with nothing on stderr. Probed on 2.24, 2.32 and 2.39, that is how all of them answer. Anything else throws `git-failed` (exit 2) with the command, its exit code and git's `error:` / `fatal:` lines. The report keeps what had resolved: history, base ref and commit, HEAD. Fetch failure reasons now also quote those lines instead of the tail of a usage text.
3. **`ci --isolate-check-git-config`.**
   - Affects the commands ci starts for the repository: run-checks' checks, verify's `check` and `snapshot` commands, and whatever they start. Their environment gets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, and loses `GIT_CONFIG_SYSTEM`. git then reads neither the system file nor `~/.gitconfig` / `$XDG_CONFIG_HOME/git/config`.
   - Does not affect ci's own fetch, deepening and merge-base, or the git calls harness-kit makes to collect the diff. They keep the host config.
   - Still applies in the checks: the repository's own config, and config passed in the environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`). That is how a job hands its checks a setting they need, such as `safe.directory` or a commit identity.
   - Not "unset `XDG_CONFIG_HOME`". git then falls back to `~/.config/git/config` and still reads `~/.gitconfig`, while other tools that read XDG config (Go's env file, pip, pnpm) lose theirs. `GIT_CONFIG_GLOBAL` replaces exactly git's global files and nothing else.
   - The global files go too, not only system and XDG. XDG is part of git's global scope, `~/.gitconfig` can hold the same rewrites, and "checks see only the repository's git config" is one rule that is easy to state and to check.
   - It needs git 2.32. Older git is `git-unsupported` rather than a partial isolation that only looks complete. For 2.24 to 2.31, examples/ci/README.md shows fetching first and running `ci --no-fetch` in an environment that hides the files holding the rules.
   - It is off by default: it also hides `safe.directory`, the identity and credential settings that existing jobs may rely on.
   - The report gains `git.checkConfig` (`host` / `isolated`).

## Verification

Real git 2.20.1 (taken from a CI image), and 2.24.0 and 2.32.0 built from upstream sources, with the published 0.9.0 as the baseline:

- git 2.20, full checkout, `ci --base main`: 0.9.0 reports `no-merge-base … share no history`. 0.9.1 reports `git-unsupported`: "harness-kit ci needs git >= 2.24 (for --end-of-options); found 2.20.1".
- The same git 2.20 behind a wrapper that claims 2.24: `git-failed`, "git merge-base --end-of-options … failed (exit 129): error: unknown option `end-of-options'".
- git 2.24.0: `ci` passes on a full and on a shallow checkout (deepened by 50). `--isolate-check-git-config` is `git-unsupported` (needs 2.32).
- git 2.32.0 and 2.47, a shallow checkout whose origin is reachable only through an `insteadOf` rule in both the system and the XDG config, plus a check that fails when origin's URL is rewritten: without the flag ci fetches and the check fails (exit 1); with it ci still fetches and the check passes (exit 0).
- `install-hooks --stop --agents codex` in a plain clone on git 2.20 and 2.24: 0.9.0 refuses it as a linked worktree; 0.9.1 installs, and still refuses in a real linked worktree. `install-hooks --git` on 2.24: 0.9.0 prints git's usage text; 0.9.1 names the 2.26 requirement.
- deliver on git 2.20 with a task record: accepted, and the ancestry warning names the version (0.9.0 printed no warning).

## Compatibility

- **CLI.** One optional `ci` flag; the cli-interface snapshot changes only in `ci --help`. No command or flag was removed or changed. The contract's `breaking_needs: minor` covers breaking changes, and an opt-in flag breaks no caller, so this is 0.9.1 (patch).
- **ci-report/v1.** Additive: the `git` object, and the `errorKind` values `git-unsupported`, `git-unavailable` and `git-failed`. A git failure that used to read as `no-merge-base`, `unresolved-base` or `shallow-history` now reads `git-failed` (still exit 2).
- **Behavior.** On git older than 2.24, `ci` fails fast with the version instead of a misleading kind, and deliver adds one warning. Nothing else changes for working setups. Jobs that need the isolation add the flag; repositories need no upgrade step.
