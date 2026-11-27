import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectChanges,
  GIT_REQUIRES,
  GitDiffError,
  gitVersionProblem,
  isAncestorCommit,
  listWorktreeFiles,
  parseGitVersion,
  readFileAtCommit,
  withoutHostGitConfig,
} from "../src/git";
import { withFakeGit } from "./fake-git";

function repoWithCommit(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-git-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  return repo;
}

test("collectChanges passes --base as an argument, never through a shell", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  assert.throws(
    () => collectChanges(repo, "HEAD; printf __HK_INJECTED__; #"),
    (error: unknown) => error instanceof GitDiffError && /invalid base/i.test(error.message),
  );
});

test("collectChanges distinguishes an invalid base from a clean diff", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  assert.throws(
    () => collectChanges(repo, "__missing_ref__"),
    (error: unknown) => error instanceof GitDiffError && error.kind === "invalid-base",
  );
  const clean = collectChanges(repo, "HEAD");
  assert.deepEqual(clean.files, []);
  assert.ok(clean.fingerprint);
});

test("an exact session base still sees changes after they are committed", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

  const changes = collectChanges(repo, base, { mode: "exact" });
  assert.deepEqual(changes.files, ["src/a.ts"]);
});

test("fingerprint changes when an untracked file changes", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  writeFileSync(join(repo, "note.txt"), "one\n");
  const first = collectChanges(repo, "HEAD");
  writeFileSync(join(repo, "note.txt"), "two\n");
  const second = collectChanges(repo, "HEAD");
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("staged changes cannot disappear when an unstaged edit restores the base content", () => {
  const repo = repoWithCommit({ "src/a.ts": "base\n" });
  writeFileSync(join(repo, "src/a.ts"), "staged-one\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  writeFileSync(join(repo, "src/a.ts"), "base\n");
  const first = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.deepEqual(first.files, ["src/a.ts"]);
  assert.ok(first.entries.some((entry) => entry.layer === "index"));
  assert.ok(first.entries.some((entry) => entry.layer === "worktree"));

  writeFileSync(join(repo, "src/a.ts"), "staged-two\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  writeFileSync(join(repo, "src/a.ts"), "base\n");
  const second = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.notEqual(first.fingerprint, second.fingerprint, "index content participates in the fingerprint");
});

test("fingerprints include the Git executable bit for worktree files", () => {
  const repo = repoWithCommit({ "script.sh": "#!/bin/sh\nexit 0\n" });
  execFileSync("git", ["config", "core.filemode", "true"], { cwd: repo });
  writeFileSync(join(repo, "script.sh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(repo, "script.sh"), 0o644);
  const regular = collectChanges(repo, "HEAD", { mode: "exact" });
  chmodSync(join(repo, "script.sh"), 0o755);
  const executable = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.notEqual(regular.fingerprint, executable.fingerprint);
});

test("fingerprints include the current submodule commit", () => {
  const child = repoWithCommit({ "value.txt": "one\n" });
  const parent = repoWithCommit({ "README.md": "parent\n" });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child"], {
    cwd: parent,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-qam", "add child"], { cwd: parent });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).trim();
  const submodule = join(parent, "vendor", "child");
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: submodule });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: submodule });

  writeFileSync(join(submodule, "value.txt"), "two\n");
  execFileSync("git", ["add", "value.txt"], { cwd: submodule });
  execFileSync("git", ["commit", "-qm", "two"], { cwd: submodule });
  const first = collectChanges(parent, base, { mode: "exact" });

  writeFileSync(join(submodule, "value.txt"), "three\n");
  execFileSync("git", ["add", "value.txt"], { cwd: submodule });
  execFileSync("git", ["commit", "-qm", "three"], { cwd: submodule });
  const second = collectChanges(parent, base, { mode: "exact" });
  assert.notEqual(first.fingerprint, second.fingerprint);

  writeFileSync(join(submodule, "value.txt"), "dirty-four\n");
  const dirtyFour = collectChanges(parent, base, { mode: "exact" });
  writeFileSync(join(submodule, "value.txt"), "dirty-five\n");
  const dirtyFive = collectChanges(parent, base, { mode: "exact" });
  assert.notEqual(dirtyFour.fingerprint, dirtyFive.fingerprint, "dirty submodule file content participates in the fingerprint");
});

test("readFileAtCommit reads target-relative files from a commit and reports absence as null", () => {
  const repo = repoWithCommit({
    "packages/app/.agents/manifest.yaml": "spec: ai-harness/v0\n",
    "packages/app/src/a.ts": "export const a = 1;\n",
    "top.txt": "top\n",
  });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "packages/app/.agents/manifest.yaml"), "spec: ai-harness/v1\n");

  const target = join(repo, "packages/app");
  assert.equal(readFileAtCommit(target, base, ".agents/manifest.yaml"), "spec: ai-harness/v0\n");
  assert.equal(readFileAtCommit(repo, base, "top.txt"), "top\n");
  assert.equal(readFileAtCommit(target, base, "missing.txt"), null);
  assert.equal(readFileAtCommit(target, base, "src"), null, "a tree is not a file");
  // Pathspec magic in a file name is taken literally.
  assert.equal(readFileAtCommit(repo, base, "*.txt"), null);
  assert.throws(() => readFileAtCommit(repo, "0".repeat(40), "top.txt"), (error: unknown) => error instanceof GitDiffError);
});

test("listWorktreeFiles finds tracked and untracked matches below a directory only", () => {
  const repo = repoWithCommit({
    "packages/app/.agents/manifest.yaml": "spec: ai-harness/v0\n",
    "packages/lib/src/lib.ts": "export const lib = 1;\n",
  });
  mkdirSync(join(repo, "packages/new/.agents"), { recursive: true });
  writeFileSync(join(repo, "packages/new/.agents/manifest.yaml"), "spec: ai-harness/v0\n");
  mkdirSync(join(repo, "ignored/.agents"), { recursive: true });
  writeFileSync(join(repo, "ignored/.agents/manifest.yaml"), "spec: ai-harness/v0\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");

  assert.deepEqual(listWorktreeFiles(repo, "**/.agents/manifest.yaml").sort(), [
    "packages/app/.agents/manifest.yaml",
    "packages/new/.agents/manifest.yaml",
  ]);
  assert.deepEqual(listWorktreeFiles(join(repo, "packages/lib"), "**/.agents/manifest.yaml"), []);
});

test("isAncestorCommit separates ancestry from Git failures", () => {
  const repo = repoWithCommit({ "a.txt": "1\n" });
  const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "2\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qam", "second"], { cwd: repo });
  assert.equal(isAncestorCommit(repo, first, "HEAD"), true);
  assert.equal(isAncestorCommit(repo, "HEAD", first), false);
  execFileSync("git", ["checkout", "-q", "--orphan", "unrelated"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "root"], { cwd: repo });
  assert.equal(isAncestorCommit(repo, first, "HEAD"), false);
  assert.throws(() => isAncestorCommit(repo, "no-such-ref", "HEAD"), GitDiffError);
});

test("a git older than a feature needs is named with both versions; an unparsed version is not refused", () => {
  assert.deepEqual(parseGitVersion("git version 2.20.1"), [2, 20]);
  assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-146)"), [2, 39]);
  assert.deepEqual(parseGitVersion("git version 2.45.1.windows.1\n"), [2, 45]);
  assert.equal(parseGitVersion("hub version 2.14.2"), null);

  const at = (text: string) => ({ text, error: null });
  const old = gitVersionProblem(GIT_REQUIRES.core, "harness-kit ci", at("git version 2.23.4"));
  assert.equal(old?.kind, "git-unsupported");
  assert.match(old!.message, /^harness-kit ci needs git >= 2\.24 \(for --end-of-options\); found 2\.23\.4\./);
  assert.equal(gitVersionProblem(GIT_REQUIRES.core, "ci", at("git version 2.24.0")), null);
  assert.equal(gitVersionProblem(GIT_REQUIRES.core, "ci", at("git version 3.0.0")), null);
  assert.equal(gitVersionProblem(GIT_REQUIRES.core, "ci", at("git version vendor-build")), null);
  assert.match(gitVersionProblem(GIT_REQUIRES.configGlobal, "x", at("git version 2.31.8"))!.message, /needs git >= 2\.32 \(for GIT_CONFIG_GLOBAL\)/);
  const missing = gitVersionProblem(GIT_REQUIRES.core, "ci", { text: null, error: "spawnSync git ENOENT" });
  assert.deepEqual(missing, { kind: "git-unavailable", message: "ci needs git, which did not run: spawnSync git ENOENT" });
});

test("isAncestorCommit refuses a git too old for its flags instead of answering", () => {
  const repo = repoWithCommit({ "a.txt": "1\n" });
  withFakeGit({ FAKE_GIT_VERSION: "2.20.1" }, () => {
    assert.throws(
      () => isAncestorCommit(repo, "HEAD", "HEAD"),
      (error: unknown) => error instanceof GitDiffError && error.kind === "git-unsupported" && /needs git >= 2\.24.*found 2\.20\.1/.test(error.message),
    );
  });
  assert.equal(isAncestorCommit(repo, "HEAD", "HEAD"), true);
});

test("withoutHostGitConfig drops the system and global git config and keeps everything else", () => {
  const env = withoutHostGitConfig({ PATH: "/bin", GIT_CONFIG_SYSTEM: "/etc/custom", GIT_CONFIG_COUNT: "1", XDG_CONFIG_HOME: "/x" });
  assert.deepEqual(env, { PATH: "/bin", GIT_CONFIG_COUNT: "1", XDG_CONFIG_HOME: "/x", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

  // What a process started with it sees: the repository's config, not the host's.
  const repo = repoWithCommit({ "a.txt": "1\n" });
  const host = mkdtempSync(join(tmpdir(), "hk-git-host-"));
  writeFileSync(join(host, "system"), "[hk]\n\tscope = system\n");
  mkdirSync(join(host, "xdg", "git"), { recursive: true });
  writeFileSync(join(host, "xdg", "git", "config"), "[hk]\n\tscope = xdg\n");
  execFileSync("git", ["config", "hk.scope", "local"], { cwd: repo });
  const values = (env: NodeJS.ProcessEnv) =>
    execFileSync("git", ["config", "--get-all", "hk.scope"], { cwd: repo, encoding: "utf8", env }).trim().split("\n");
  const hostEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_SYSTEM: join(host, "system"), XDG_CONFIG_HOME: join(host, "xdg"), HOME: host };
  delete hostEnv.GIT_CONFIG_NOSYSTEM;
  delete hostEnv.GIT_CONFIG_GLOBAL;
  assert.deepEqual(values(hostEnv), ["system", "xdg", "local"]);
  assert.deepEqual(values(withoutHostGitConfig(hostEnv)), ["local"]);
});
