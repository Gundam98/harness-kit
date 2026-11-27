# CI merge gate examples

`harness-kit ci` is the gate that runs on every merge / pull request, whoever made the change and wherever. Its result is the CI job's status on the merge request, so nobody (Agent or human) can claim it ran. `deliver` and the SessionStart / Stop hooks stay the fast local feedback loop; `ci` is what the merge waits for.

- [`github-actions.yml`](github-actions.yml): GitHub Actions workflow (pull requests and pushes to `main`).
- [`gitlab-ci.yml`](gitlab-ci.yml): GitLab CI job (merge request pipelines and pushes to the default branch).

Both check out the full history, set up Node.js 22 (harness-kit needs 18 or later), install the repository's own dependencies (run-checks executes its test / typecheck capabilities), and call the CLI pinned to the version in `.agents/harness.lock.json`. The job image needs git 2.24 or later; the GitHub-hosted runners and the `node` images have newer ones.

After adding the job, declare its file in the manifest, so changing it counts as a Harness path instead of an `unmapped-file`:

```yaml
validation:
  ci_configs: [.github/workflows/harness.yml]   # or .gitlab-ci.yml, or any other platform's pipeline file
```

Entries are exact paths, not globs. verify then checks that each declared file exists and that at least one of them still calls `harness-kit … ci` (a textual match; a workflow that calls a script passes when the script is declared too), so removing the gate fails verify.

## What `ci` does

1. **Git.** It checks the version first: older than 2.24 (merge-base and fetch need `--end-of-options`) is a configuration error that names the required and the found version, not a misleading "no common history".
2. **Base.** The first of these that is set:
   1. `--base <ref>`
   2. `HARNESS_KIT_BASE`
   3. GitLab merge request pipelines: `CI_MERGE_REQUEST_DIFF_BASE_SHA`, or `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (also used first in merged-result / merge-train pipelines, whose HEAD is a merge commit on the target)
   4. GitHub `pull_request` / `pull_request_target`: `GITHUB_BASE_REF`
   5. The pushed range: the `before` of a GitHub `push` event, the `merge_group.base_sha` of a GitHub merge queue, or GitLab `CI_COMMIT_BEFORE_SHA`

   None set (for example the first push of a new branch, or a scheduled pipeline) is a configuration error. `ci` never falls back to `HEAD~1` or similar.
3. **History.** It fetches the base from `origin` (`--remote` to change, `--no-fetch` to use local history only). In a shallow checkout it deepens step by step, then unshallows. If there is still no merge-base, it exits 2 with the reason. A git command that fails, rather than answering "no such ref" or "no common ancestor", exits 2 as `git-failed` with git's error output.
4. **Judgement.** run-checks and verify run against the same merge-base. Context staleness that already exists on the base counts as the target branch's maintenance, the same rule `deliver` applies; plain `verify` stays strict. A selected check that cannot see the change is reported in `warnings`: today, a `git diff --check` without a base, which on a clean checkout passes without checking anything (make its run `git diff --check ${HARNESS_KIT_BASE:-HEAD}`; `upgrade` rewrites the exact base-less command).
5. **No local state.** It neither reads nor writes delivery stamps, task records, or waivers. A waiver recorded by a local `run-checks` does not apply in CI: add the test, or change the module's policy in the manifest.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Passed: the selected checks and verify passed (or nothing changed against the merge-base). |
| 1 | The change failed: a check failed, a blocking gap remains, or verify failed. |
| 2 | Configuration / environment error; the change was not judged. No base, invalid base, base not found, shallow history that cannot be deepened, no common history, git too old, missing or failing, no manifest, or a malformed command line. |

## JSON (`--json`)

One `ai-harness/ci-report/v1` document:

- `status`: `passed` / `failed` / `error`. Also `ok`, `exitCode`, and `errorKind` (set on error: `no-base`, `invalid-base`, `unresolved-base`, `shallow-history`, `no-merge-base`, `git-unsupported`, `git-unavailable`, `git-failed`, `not-adopted`, ...).
- `git`: `version` (the git on `PATH`) and `checkConfig` (`host`, or `isolated` with `--isolate-check-git-config`).
- `base`: `source` (for example `GITHUB_BASE_REF`), `value`, the locally resolved `ref` and `commit`, `mergeBase`, and `head`.
- `history`: `shallow`, `fetch` (`fetched` / `present` / `skipped` / `failed` / `unavailable`), `deepened`, `unshallowed`, every git `commands` run, and `warnings`.
- `changed`; `checks` (each selected check with `status`, `exitCode`, `durationMs`); `blockingGaps`.
- `runChecks` and `verify`: the full run-checks and verify reports. `verifyPassed` is a boolean.
- `warnings` (do not change the verdict) and `errors`.

## Host git config and the checks

By default `ci`'s own git calls and the checks it starts see the same git config: the host's. Some build machines put `url.<base>.insteadOf` rules in the system or user (XDG) git config. `ci`'s fetch needs them to reach the remote; a check that reads the remote URL should not see them. `--isolate-check-git-config` (git 2.32 or later) separates the two:

- **Isolated:** every command `ci` starts for the repository (run-checks' checks, verify's `check` and `snapshot` commands) and whatever those start. They run with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`: git reads neither the system file nor `~/.gitconfig` / `$XDG_CONFIG_HOME/git/config`. Other tools' configuration is untouched.
- **Not isolated:** `ci`'s own fetch, deepening and merge-base, and the git calls harness-kit makes to collect the diff. They keep the host's config.
- **Still applies in the checks:** the repository's own git config, and settings passed in the environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`). Isolation drops every host setting, not only URL rewrites; pass what the checks need, such as `safe.directory` or `user.name` / `user.email`, this way.

Git 2.24 to 2.31 runs `ci` but has no setting that only git reads for the global files. There, fetch first with the host's config, then run `ci` without fetching in an environment that hides the files holding the rules, for example:

```sh
git fetch --no-tags origin "+refs/heads/${TARGET_BRANCH}:refs/remotes/origin/${TARGET_BRANCH}"
GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME="$(mktemp -d)" npx -y "@erzhe/harness-kit@${version}" ci --no-fetch
```

`--no-fetch` never deepens, so check out the full history. Moving `XDG_CONFIG_HOME` hides that directory from every tool the checks run, and `~/.gitconfig` is still read; adjust to where the rules live.

Files the job itself creates before `ci` runs (build output that is not ignored) become part of the judged change, so run `ci` on the fresh checkout or keep generated files in `.gitignore`.
