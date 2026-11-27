import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * A PATH whose `git` behaves like an older or failing git where asked and
 * passes every other call to the real one:
 * - FAKE_GIT_VERSION=2.20.1: `git --version` reports that release.
 * - FAKE_GIT_FAIL=merge-base: that subcommand fails with a fatal line and a usage text (exit 128).
 * - FAKE_GIT_ECHO_PATH_FORMAT=1: `rev-parse --path-format=absolute` echoes the
 *   flag and goes on, as git before 2.31 does.
 */
export function fakeGitPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-fake-git-"));
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh
if [ -n "$FAKE_GIT_VERSION" ] && [ "$1" = --version ]; then echo "git version $FAKE_GIT_VERSION"; exit 0; fi
if [ -n "$FAKE_GIT_FAIL" ] && [ "$1" = "$FAKE_GIT_FAIL" ]; then
  printf 'fatal: simulated %s failure\nusage: git %s [<options>]\n\n    -a, --all    simulated option help\n' "$1" "$1" >&2
  exit 128
fi
if [ -n "$FAKE_GIT_ECHO_PATH_FORMAT" ] && [ "$1" = rev-parse ] && [ "$2" = --path-format=absolute ]; then
  echo "$2"
  shift 2
  exec ${JSON.stringify(REAL_GIT)} rev-parse "$@"
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`,
    { mode: 0o755 },
  );
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

/** Run `fn` in this process with the fake git first on PATH and `fake` set; restores both. */
export function withFakeGit<T>(fake: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(["PATH", ...Object.keys(fake)].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PATH: fakeGitPath(), ...fake });
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
