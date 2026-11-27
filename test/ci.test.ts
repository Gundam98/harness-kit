import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCiBase } from "../src/ci";
import { syncCmd } from "../src/commands/sync";
import { gitAdminDir } from "../src/git";
import { fakeGitPath } from "./fake-git";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

const MANIFEST = `spec: ai-harness/v0
identity:
  name: ci-fixture
  summary: ci gate fixture
capabilities:
  test:
    run: "node checks/test.mjs"
modules:
  - name: core
    role: fixture code
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
invariants:
  - id: no-todo-in-src
    rule: no TODO markers in src
    enforcement:
      forbid_pattern: ["TODO"]
      path_glob: ["src/**"]
`;

// The fixture's test capability fails when src/core.ts says "broken".
const CHECK = `import { readFileSync } from "node:fs";
process.exit(readFileSync("src/core.ts", "utf8").includes("broken") ? 1 : 0);
`;

// A capability, an invariant check, and a contract snapshot that each see
// whether git rewrites origin's URL (url.<base>.insteadOf from host config).
const ORIGIN_URL_MANIFEST = MANIFEST.replace("checks: [test]", "checks: [test, origin-url]")
  .replace(
    'run: "node checks/test.mjs"',
    'run: "node checks/test.mjs"\n  origin-url:\n    run: "node checks/origin-url.mjs --check"',
  )
  .concat(`  - id: origin-url-as-configured
    rule: checks see origin's URL as the repository configures it
    check: "node checks/origin-url.mjs --check"
contracts:
  - id: origin-url
    kind: other
    desc: what a check sees as origin's URL
    snapshot: "node checks/origin-url.mjs"
`);
const ORIGIN_URL_CHECK = `import { execFileSync } from "node:child_process";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const state = git("config", "--get", "remote.origin.url") === git("ls-remote", "--get-url", "origin") ? "as configured" : "rewritten";
if (process.argv.includes("--check")) process.exit(state === "as configured" ? 0 : 1);
process.stdout.write(state + "\\n");
`;

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** origin: main with history, plus a feature branch three commits ahead of a main that moved on. */
function origin(manifest = MANIFEST, files: Record<string, string> = {}): { dir: string; forkPoint: string } {
  const dir = mkdtempSync(join(tmpdir(), "hk-ci-origin-"));
  git(dir, ["init", "-q", "-b", "main"]);
  write(dir, ".agents/manifest.yaml", manifest);
  write(dir, "checks/test.mjs", CHECK);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  write(dir, "src/core.ts", "export const value = 1;\n");
  write(dir, "test/core.test.ts", "// covers 1\n");
  syncCmd(dir, { createEntry: true });
  commit(dir, "initial");
  for (let index = 0; index < 5; index++) {
    write(dir, `docs/note-${index}.md`, `note ${index}\n`);
    commit(dir, `main history ${index}`);
  }
  const forkPoint = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  for (let index = 2; index <= 4; index++) {
    write(dir, "src/core.ts", `export const value = ${index};\n`);
    write(dir, "test/core.test.ts", `// covers ${index}\n`);
    commit(dir, `feature ${index}`);
  }
  git(dir, ["checkout", "-q", "main"]);
  write(dir, "docs/after-fork.md", "main moved on\n");
  commit(dir, "main after fork");
  return { dir, forkPoint };
}

/** A CI-like checkout of the feature branch: full, or shallow (depth 1, single branch). */
function checkout(source: string, shallow: boolean): string {
  const dir = join(mkdtempSync(join(tmpdir(), "hk-ci-clone-")), "repo");
  const args = shallow
    ? ["clone", "-q", "--depth", "1", "--single-branch", "--branch", "feature", `file://${source}`, dir]
    : ["clone", "-q", "--branch", "feature", source, dir];
  execFileSync("git", args, { stdio: "ignore" });
  return dir;
}

/** The test runner's own CI variables must never leak into these runs. */
function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(GITHUB_|GITLAB_|CI_|HARNESS_KIT_BASE$)/.test(key)) env[key] = value;
  return { ...env, ...extra };
}

function ci(repo: string, args: string[] = [], extra: Record<string, string | undefined> = {}): { code: number; body: any; stdout: string } {
  const result = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--json", ...args], { cwd: repo, encoding: "utf8", env: cleanEnv(extra) });
  let body: any = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  return { code: result.status ?? -1, body, stdout: result.stdout + result.stderr };
}

function localStateFiles(repo: string): string[] {
  const dir = join(gitAdminDir(repo), "harness-kit");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

test("the base comes from --base first, then HARNESS_KIT_BASE, then the CI platform", () => {
  const gitlab = { GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DIFF_BASE_SHA: SHA_A };
  assert.deepEqual(detectCiBase("release", { ...gitlab, HARNESS_KIT_BASE: "develop", GITHUB_BASE_REF: "main" }), { source: "option", value: "release" });
  assert.deepEqual(detectCiBase(undefined, { ...gitlab, HARNESS_KIT_BASE: "develop" }), { source: "HARNESS_KIT_BASE", value: "develop" });
  assert.deepEqual(detectCiBase("  ", { HARNESS_KIT_BASE: " develop " }), { source: "HARNESS_KIT_BASE", value: "develop" });
  // GitLab: the MR diff base, except in merged-result / merge-train pipelines whose HEAD sits on the target tip.
  assert.deepEqual(detectCiBase(undefined, gitlab), { source: "CI_MERGE_REQUEST_DIFF_BASE_SHA", value: SHA_A });
  assert.deepEqual(detectCiBase(undefined, { ...gitlab, CI_MERGE_REQUEST_EVENT_TYPE: "merged_result" }), {
    source: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    value: "main",
  });
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }), {
    source: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    value: "main",
  });
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_MERGE_REQUEST_DIFF_BASE_SHA: SHA_B }), {
    source: "CI_MERGE_REQUEST_DIFF_BASE_SHA",
    value: SHA_B,
  });
  // GitHub pull_request / pull_request_target.
  assert.deepEqual(detectCiBase(undefined, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }), {
    source: "GITHUB_BASE_REF",
    value: "main",
  });
});

test("push and merge-queue pipelines judge the pushed range; a new branch has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-ci-event-"));
  const event = (name: string, payload: unknown) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(payload));
    return { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: path, GITHUB_BASE_REF: "" };
  };
  assert.deepEqual(detectCiBase(undefined, event("push", { before: SHA_A, after: SHA_B })), { source: "GITHUB_EVENT_PATH:before", value: SHA_A });
  assert.equal(detectCiBase(undefined, event("push", { before: ZERO, after: SHA_B })), null, "branch creation has no before");
  assert.deepEqual(detectCiBase(undefined, event("merge_group", { merge_group: { base_sha: SHA_B } })), {
    source: "GITHUB_EVENT_PATH:merge_group.base_sha",
    value: SHA_B,
  });
  assert.equal(detectCiBase(undefined, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(dir, "missing.json") }), null);
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "push", CI_COMMIT_BEFORE_SHA: SHA_A }), {
    source: "CI_COMMIT_BEFORE_SHA",
    value: SHA_A,
  });
  assert.equal(detectCiBase(undefined, { GITLAB_CI: "true", CI_COMMIT_BEFORE_SHA: ZERO }), null);
  assert.equal(detectCiBase(undefined, { CI_COMMIT_BEFORE_SHA: SHA_A }), null, "only inside GitLab CI");
  assert.equal(detectCiBase(undefined, {}), null);
});

test("ci passes a good change against the merge-base and leaves no local delivery state", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, false);
  const before = localStateFiles(repo);
  const { code, body, stdout } = ci(repo, ["--base", "main"]);
  assert.equal(code, 0, stdout);
  assert.equal(body.schema, "ai-harness/ci-report/v1");
  assert.deepEqual({ status: body.status, ok: body.ok, exitCode: body.exitCode }, { status: "passed", ok: true, exitCode: 0 });
  assert.equal(body.base.source, "option");
  assert.equal(body.base.ref, "refs/remotes/origin/main");
  // main moved on after the fork; the change is judged from the fork point, not main's tip.
  assert.equal(body.base.mergeBase, forkPoint);
  assert.notEqual(body.base.commit, forkPoint);
  assert.equal(body.history.fetch, "fetched");
  assert.deepEqual(body.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.deepEqual(body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"]]);
  assert.equal(body.verifyPassed, true);
  assert.equal(body.verify.schema, "ai-harness/verify-report/v1");
  assert.deepEqual(localStateFiles(repo), before, "no stamp, task record, waiver, or evidence written");
  const evidence = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(JSON.parse(evidence.stdout).found, false);

  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /harness-kit ci — base main from option/);
  assert.match(text.stdout, /merge-base [0-9a-f]{12}/);
  assert.match(text.stdout, /OK {3}test \(/);
  assert.match(text.stdout, /OK {3}ci: PASSED/);
});

test("each CI variable source drives the same gate", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, false);
  const cases: Array<[Record<string, string>, string]> = [
    [{ HARNESS_KIT_BASE: "main" }, "HARNESS_KIT_BASE"],
    [{ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, "GITHUB_BASE_REF"],
    [{ GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_EVENT_TYPE: "merged_result" }, "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"],
    [{ GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DIFF_BASE_SHA: forkPoint }, "CI_MERGE_REQUEST_DIFF_BASE_SHA"],
  ];
  for (const [env, source] of cases) {
    const { code, body, stdout } = ci(repo, [], env);
    assert.equal(code, 0, `${source}: ${stdout}`);
    assert.equal(body.base.source, source);
    assert.equal(body.base.mergeBase, forkPoint, source);
  }
  // The option still wins over every variable.
  const { body } = ci(repo, ["--base", forkPoint], { HARNESS_KIT_BASE: "does-not-exist", GITHUB_BASE_REF: "nope" });
  assert.equal(body.base.source, "option");
  assert.equal(body.history.fetch, "present");
});

test("no base is a configuration error, never a guess", () => {
  const { dir } = origin();
  const repo = checkout(dir, false);
  const { code, body } = ci(repo);
  assert.equal(code, 2);
  assert.deepEqual({ status: body.status, errorKind: body.errorKind }, { status: "error", errorKind: "no-base" });
  assert.match(body.errors[0], /never guesses a base such as HEAD~1/);
  assert.equal(body.runChecks, null, "nothing was judged");

  for (const [args, kind] of [[["--base", "does-not-exist"], "unresolved-base"], [["--base", "--upload-pack=evil"], "invalid-base"], [["--base", "main..feature"], "invalid-base"]] as const) {
    const result = ci(repo, [...args]);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(result.body?.errorKind ?? kind, kind, result.stdout);
  }
  const usage = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--no-such-flag"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(usage.status, 2, "a malformed invocation is a configuration error, not a failed change");

  const plain = mkdtempSync(join(tmpdir(), "hk-ci-plain-"));
  git(plain, ["init", "-q"]);
  const unadopted = ci(plain, ["--base", "main"]);
  assert.equal(unadopted.code, 2);
  assert.equal(unadopted.body.errorKind, "not-adopted");
});

test("a shallow checkout is deepened until the merge-base is local", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, true);
  assert.equal(git(repo, ["rev-parse", "--is-shallow-repository"]), "true");
  const { code, body, stdout } = ci(repo, [], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" });
  assert.equal(code, 0, stdout);
  assert.equal(body.history.shallow, true);
  assert.equal(body.history.fetch, "fetched");
  assert.ok(body.history.deepened > 0, JSON.stringify(body.history));
  assert.ok(body.history.commands.some((command: string) => /--deepen=\d+/.test(command)));
  assert.equal(body.base.mergeBase, forkPoint);
  assert.deepEqual(body.changed, ["src/core.ts", "test/core.test.ts"]);
});

test("a shallow checkout that cannot be deepened fails as an environment error", () => {
  const { dir } = origin();
  // --no-fetch: local history only.
  const offline = checkout(dir, true);
  git(offline, ["fetch", "-q", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const local = ci(offline, ["--base", "origin/main", "--no-fetch"]);
  assert.equal(local.code, 2, local.stdout);
  assert.equal(local.body.errorKind, "shallow-history");
  assert.match(local.body.errors[0], /fetch-depth: 0.*GIT_DEPTH: 0/);
  assert.equal(local.body.history.fetch, "skipped");
  // What did resolve is still reported, so the job log shows how far it got.
  assert.equal(local.body.base.ref, "refs/remotes/origin/main");
  assert.match(local.body.base.commit, /^[0-9a-f]{40}$/);
  assert.equal(local.body.base.mergeBase, null);

  // The remote is gone after checkout: the base is local, deepening is impossible.
  const unreachable = checkout(dir, true);
  git(unreachable, ["fetch", "-q", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  git(unreachable, ["remote", "set-url", "origin", join(dir, "missing")]);
  const failed = ci(unreachable, ["--base", "main"]);
  assert.equal(failed.code, 2, failed.stdout);
  assert.equal(failed.body.errorKind, "shallow-history");
  assert.equal(failed.body.history.fetch, "failed");
  assert.match(failed.body.errors[0], /deepening from origin failed/);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", unreachable, "--base", "main"], { cwd: unreachable, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /could not fetch main from origin/);
  assert.match(text.stdout, /ci: ERROR — the change was not judged \(exit 2\)/);
});

test("unrelated history is an environment error", () => {
  const { dir } = origin();
  git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
  commit(dir, "unrelated root");
  git(dir, ["checkout", "-q", "main"]);
  const repo = checkout(dir, false);
  const { code, body } = ci(repo, ["--base", "unrelated"]);
  assert.equal(code, 2);
  assert.equal(body.errorKind, "no-merge-base");
});

test("a failing check and a failing verify are check failures (exit 1)", () => {
  const { dir } = origin();
  const repo = checkout(dir, false);
  write(repo, "src/core.ts", "export const value = 'broken';\n");
  write(repo, "test/core.test.ts", "// covers broken\n");
  commit(repo, "break the check");
  const broken = ci(repo, ["--base", "main"]);
  assert.equal(broken.code, 1, broken.stdout);
  assert.deepEqual({ status: broken.body.status, errorKind: broken.body.errorKind }, { status: "failed", errorKind: null });
  assert.deepEqual(broken.body.checks.map((check: any) => [check.id, check.status]), [["test", "failed"]]);
  assert.equal(broken.body.runChecks.failed[0].cmd, "node checks/test.mjs");
  assert.equal(broken.body.verifyPassed, true);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /ERR {2}test: FAILED \(exit 1\) — node checks\/test\.mjs/);
  assert.match(text.stdout, /ci: FAILED/);

  // Checks pass, an invariant does not.
  write(repo, "src/core.ts", "export const value = 5; // TODO\n");
  write(repo, "test/core.test.ts", "// covers 5\n");
  commit(repo, "violate an invariant");
  const invariant = ci(repo, ["--base", "main"]);
  assert.equal(invariant.code, 1, invariant.stdout);
  assert.equal(invariant.body.verifyPassed, false);
  assert.deepEqual(invariant.body.checks.map((check: any) => check.status), ["passed"]);
  assert.ok(invariant.body.verify.messages.some((message: any) => message.level === "error" && /no-todo-in-src: 1 violation/.test(message.text)));

  // A missing test touch is blocking in CI even if a local run-checks waived it: waivers are local state.
  write(repo, "src/core.ts", "export const value = 5;\n");
  const clean = commit(repo, "fix the invariant");
  write(repo, "src/core.ts", "export const value = 6;\n");
  commit(repo, "source without test");
  const waived = spawnSync(
    TSX,
    [CLI, "run-checks", "--repo", repo, "--base", clean, "--waive", "missing-test-touch", "--where", "core", "--reason", "local only"],
    { cwd: repo, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(waived.status, 0, waived.stdout);
  const gap = ci(repo, ["--base", clean]);
  assert.equal(gap.code, 1, gap.stdout);
  assert.ok(gap.body.blockingGaps.some((item: any) => item.kind === "missing-test-touch" && item.where === "core"));
  const gapText = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", clean], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.match(gapText.stdout, /waivers recorded by a local run-checks do not apply in CI/);
});

test("a git too old for ci, or failing, is an environment error that says so", () => {
  const { dir } = origin();
  const repo = checkout(dir, false);
  const PATH = fakeGitPath();

  // An old git rejects merge-base / fetch --end-of-options; that must not read as "no history".
  const old = ci(repo, ["--base", "main"], { PATH, FAKE_GIT_VERSION: "2.20.1" });
  assert.equal(old.code, 2, old.stdout);
  assert.deepEqual({ status: old.body.status, errorKind: old.body.errorKind }, { status: "error", errorKind: "git-unsupported" });
  assert.match(old.body.errors[0], /^harness-kit ci needs git >= 2\.24 \(for --end-of-options\); found 2\.20\.1\./);
  assert.equal(old.body.git.version, "2.20.1");
  assert.equal(old.body.history, null, "nothing was fetched");
  assert.equal(old.body.runChecks, null);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv({ PATH, FAKE_GIT_VERSION: "2.20.1" }),
  });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /git: 2\.20\.1; checks inherit the host's git config/);
  assert.match(text.stdout, /ERR {2}harness-kit ci needs git >= 2\.24/);

  const isolation = ci(repo, ["--base", "main", "--isolate-check-git-config"], { PATH, FAKE_GIT_VERSION: "2.31.0" });
  assert.equal(isolation.code, 2, isolation.stdout);
  assert.equal(isolation.body.errorKind, "git-unsupported");
  assert.match(isolation.body.errors[0], /--isolate-check-git-config needs git >= 2\.32 \(for GIT_CONFIG_GLOBAL\); found 2\.31\.0/);

  // git failing is not "share no history": its stderr is in the report, with what had resolved.
  const failing = ci(repo, ["--base", "main"], { PATH, FAKE_GIT_FAIL: "merge-base" });
  assert.equal(failing.code, 2, failing.stdout);
  assert.equal(failing.body.errorKind, "git-failed");
  assert.match(failing.body.errors[0], /^git merge-base --end-of-options [0-9a-f]{40} [0-9a-f]{40} failed \(exit 128\): fatal: simulated merge-base failure$/);
  assert.equal(failing.body.history.fetch, "fetched");
  assert.equal(failing.body.base.ref, "refs/remotes/origin/main");
  assert.match(failing.body.base.head, /^[0-9a-f]{40}$/);
  assert.equal(failing.body.base.mergeBase, null);
});

test("--isolate-check-git-config keeps the host's git config from the checks, not from ci's fetch", () => {
  const { dir } = origin(ORIGIN_URL_MANIFEST, {
    "checks/origin-url.mjs": ORIGIN_URL_CHECK,
    ".agents/contracts/origin-url.snapshot": "as configured\n",
  });
  // Shallow, and origin only reachable through the host's URL rewrite: ci has to fetch through it.
  const repo = checkout(dir, true);
  const url = "https://git.example.invalid/fixture.git";
  git(repo, ["remote", "set-url", "origin", url]);
  const host = mkdtempSync(join(tmpdir(), "hk-ci-host-"));
  const rewrite = `[url "file://${dir}"]\n\tinsteadOf = ${url}\n`;
  write(host, "system-gitconfig", rewrite);
  write(host, "xdg/git/config", rewrite);
  // The host config is simulated, so an isolated outer run (ci gating this repository) must not hide it.
  const hostEnv = {
    GIT_CONFIG_SYSTEM: join(host, "system-gitconfig"),
    XDG_CONFIG_HOME: join(host, "xdg"),
    GIT_CONFIG_NOSYSTEM: undefined,
    GIT_CONFIG_GLOBAL: undefined,
  };

  const inherited = ci(repo, ["--base", "main"], hostEnv);
  assert.equal(inherited.code, 1, inherited.stdout);
  assert.equal(inherited.body.git.checkConfig, "host");
  assert.equal(inherited.body.history.fetch, "fetched");
  assert.deepEqual(inherited.body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"], ["origin-url", "failed"]]);
  const errors = inherited.body.verify.messages.filter((message: any) => message.level === "error").map((message: any) => message.text);
  assert.ok(errors.some((text: string) => /^origin-url-as-configured: check failed/.test(text)), errors.join("\n"));
  assert.ok(errors.some((text: string) => /^origin-url: contract drifted from baseline/.test(text)), errors.join("\n"));

  const isolated = ci(repo, ["--base", "main", "--isolate-check-git-config"], hostEnv);
  assert.equal(isolated.code, 0, isolated.stdout);
  assert.equal(isolated.body.git.checkConfig, "isolated");
  assert.equal(isolated.body.history.fetch, "fetched", "ci's own fetch still used the host's rewrite");
  assert.deepEqual(isolated.body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"], ["origin-url", "passed"]]);
  assert.equal(isolated.body.verifyPassed, true);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main", "--isolate-check-git-config"], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(hostEnv),
  });
  assert.equal(text.status, 0, text.stdout);
  assert.match(text.stdout, /checks run without the host's system \/ global \/ XDG git config/);
});

test("a base-less diff check passes in CI without checking anything, and ci says so", () => {
  const manifest = MANIFEST.replace("checks: [test]", "checks: [test, diff_check]").replace(
    'run: "node checks/test.mjs"',
    'run: "node checks/test.mjs"\n  diff_check:\n    run: "git diff --check"',
  );
  const { dir } = origin(manifest);
  const repo = checkout(dir, false);
  // A committed whitespace error: what the check exists to catch.
  write(repo, "src/core.ts", "export const value = 7;   \n");
  write(repo, "test/core.test.ts", "// covers 7\n");
  commit(repo, "trailing whitespace");

  const vacuous = ci(repo, ["--base", "main"]);
  assert.equal(vacuous.code, 0, vacuous.stdout);
  assert.deepEqual(vacuous.body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"], ["diff_check", "passed"]]);
  assert.equal(vacuous.body.warnings.length, 1);
  assert.match(vacuous.body.warnings[0], /^capability diff_check runs `git diff --check` without a base: .*ci \(a clean checkout\) passes it without checking anything/);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.match(text.stdout, /WARN capability diff_check runs `git diff --check` without a base/);

  // With the judged base it sees the committed change and fails it.
  write(repo, ".agents/manifest.yaml", readFileSync(join(repo, ".agents/manifest.yaml"), "utf8").replace('run: "git diff --check"', 'run: "git diff --check ${HARNESS_KIT_BASE:-HEAD}"'));
  syncCmd(repo, {});
  commit(repo, "diff_check sees the task base");
  const real = ci(repo, ["--base", "main"]);
  assert.equal(real.code, 1, real.stdout);
  assert.deepEqual(real.body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"], ["diff_check", "failed"]]);
  assert.deepEqual(real.body.warnings, []);
});

test("a declared CI config is a Harness path in the gate it configures", () => {
  const workflow = (step: string) => `jobs:\n  harness:\n    steps:\n      - run: ${step}\n`;
  const { dir } = origin(`${MANIFEST}validation:\n  ci_configs: [.github/workflows/harness.yml]\n`, {
    ".github/workflows/harness.yml": workflow('npx -y "@erzhe/harness-kit@${version}" ci'),
  });
  const repo = checkout(dir, false);
  write(repo, ".github/workflows/harness.yml", workflow('npx -y "@erzhe/harness-kit@${version}" ci --isolate-check-git-config'));
  commit(repo, "isolate the checks' git config");
  const { code, body, stdout } = ci(repo, ["--base", "main"]);
  assert.equal(code, 0, stdout);
  assert.ok(body.changed.includes(".github/workflows/harness.yml"));
  assert.ok(!body.runChecks.gaps.some((gap: any) => gap.kind === "unmapped-file"), JSON.stringify(body.runChecks.gaps));
  assert.ok(body.verify.messages.some((message: any) => message.text === ".github/workflows/harness.yml runs harness-kit ci"));
});
