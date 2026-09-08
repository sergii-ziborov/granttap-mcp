import { execFileSync } from "node:child_process";

/**
 * The only part of publication analysis that touches the machine.
 *
 * Everything above it is a pure function of what this returns, which is what
 * lets the detectors be tested against fixture strings instead of a repository.
 */
export type PublicationGitReader = {
  /** Trimmed stdout, or undefined on any failure. Never throws. */
  read(cwd: string, args: readonly string[]): string | undefined;
  /** Untrimmed stdout, for NUL-delimited output. */
  readRaw(cwd: string, args: readonly string[]): string | undefined;
};

/**
 * Four mebibytes, not the smaller cap used for hashing a dirty tree.
 *
 * A truncated diff and an empty diff are indistinguishable once the buffer
 * overflows, and reading "no delta" from a large one would turn a false
 * negative into an all-clear. The caller still reports truncation explicitly.
 */
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

export function defaultPublicationGitReader(): PublicationGitReader {
  const run = (cwd: string, args: readonly string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch {
      return undefined;
    }
  };
  return {
    read: (cwd, args) => run(cwd, args)?.trim() || undefined,
    readRaw: (cwd, args) => run(cwd, args),
  };
}
