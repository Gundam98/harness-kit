import type { Manifest } from "./manifest";

/** The starter whitespace check init writes: the judged diff when run-checks / ci set HARNESS_KIT_BASE, else uncommitted changes. */
export const DIFF_CHECK_RUN = "git diff --check ${HARNESS_KIT_BASE:-HEAD}";
/** The base-less command some early manifests carry; upgrade rewrites exactly this value to DIFF_CHECK_RUN. */
export const BASELESS_DIFF_CHECK_RUN = "git diff --check";

const SEPARATORS = /&&|\|\||[;|\n]/;
// git's own options that take the next word as their value (git -C dir diff ...).
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/**
 * True when `run` calls `git diff --check` with no revision, or with HEAD
 * only. That compares the worktree with the index (or HEAD): committed
 * changes are never checked, and on a clean CI checkout it passes without
 * checking anything. Whatever this cannot read (a variable, a command
 * substitution, a range, a path pair) counts as a base, so it never flags a
 * command that may be right.
 */
export function diffCheckWithoutBase(run: string): boolean {
  return run.split(SEPARATORS).some((segment) => {
    const tokens = segment.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
    const git = tokens.indexOf("git");
    if (git < 0) return false;
    let index = git + 1;
    while (index < tokens.length && tokens[index]!.startsWith("-")) index += GIT_OPTIONS_WITH_VALUE.has(tokens[index]!) ? 2 : 1;
    if (tokens[index] !== "diff") return false;
    const args = tokens.slice(index + 1);
    const end = args.indexOf("--");
    const options = end < 0 ? args : args.slice(0, end);
    return options.includes("--check") && options.filter((arg) => !arg.startsWith("-")).every((arg) => arg === "HEAD");
  });
}

/** Capabilities whose run is such a check, in manifest order. */
export function capabilitiesWithoutDiffBase(m: Manifest): string[] {
  return Object.entries(m.capabilities ?? {})
    .filter(([, capability]) => typeof capability?.run === "string" && diffCheckWithoutBase(capability.run))
    .map(([id]) => id);
}

/** What doctor and ci say about one such capability. */
export function diffCheckWithoutBaseMessage(id: string): string {
  return (
    `capability ${id} runs \`git diff --check\` without a base: it only sees uncommitted changes, so deliver never checks ` +
    `committed task changes and ci (a clean checkout) passes it without checking anything. Make its run ` +
    `\`${DIFF_CHECK_RUN}\` (run-checks and ci set HARNESS_KIT_BASE to the judged base)`
  );
}
