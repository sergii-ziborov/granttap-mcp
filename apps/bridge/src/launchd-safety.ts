/**
 * A LaunchAgent is user-global: `launchctl bootstrap` replaces whatever job
 * already holds that label. A sandboxed run — a test, a probe, anything with a
 * temporary `HOME` or config directory — therefore evicts the real GrantTap
 * helper and installs a job whose plist, node modules, and log file vanish with
 * the temporary directory. launchd then keeps restarting a program it can no
 * longer load, which reads to the user as GrantTap crashing in a loop.
 *
 * A real installation always writes into the user's own Library. A plist under
 * the operating system's temporary directory is a sandbox by definition, so it
 * never reaches the live domain.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const TEMPORARY_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function insideTemporaryDirectory(path: string): boolean {
  if (process.env.GRANTTAP_TEST_FAKE_LAUNCHCTL === "1") return false;
  const target = canonical(path);
  const roots = new Set<string>();
  for (const root of [tmpdir(), ...TEMPORARY_ROOTS]) {
    roots.add(resolve(root));
    roots.add(canonical(root));
  }
  return [...roots].some((root) => target === root || target.startsWith(root + sep));
}

export const SANDBOXED_LAUNCH_AGENT_DETAIL =
  "refusing to load a LaunchAgent from a temporary directory; "
  + "a sandboxed run must not replace the installed GrantTap helper";

export const CLOBBER_LIVE_HELPER_DETAIL =
  "refusing to rewrite the installed GrantTap helper from a temporary config; "
  + "a sandboxed run must not replace the live LaunchAgent";

/**
 * Whether this plist may be handed to `launchctl` in the live user domain.
 *
 * `GRANTTAP_TEST_FAKE_LAUNCHCTL=1` states that the `launchctl` on PATH is a
 * stub, so the whole install path can be exercised without a live domain to
 * damage. It is an explicit, greppable opt-in; nothing in the shipped product
 * sets it.
 */
export function refusesLiveLaunchd(path: string): string | null {
  if (process.env.GRANTTAP_TEST_FAKE_LAUNCHCTL === "1") return null;
  return insideTemporaryDirectory(path) ? `${path}: ${SANDBOXED_LAUNCH_AGENT_DETAIL}` : null;
}

function unescapePlistPath(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

/** True when a helper plist would log or run from a directory that vanishes. */
export function plistUsesTemporaryIO(contents: string): boolean {
  const paths = [...contents.matchAll(
    /<key>(?:StandardErrorPath|StandardOutPath|WorkingDirectory)<\/key>\s*<string>([^<]*)<\/string>/g,
  )].map((match) => unescapePlistPath(match[1] ?? ""));
  return paths.some((path) => path.length > 0 && insideTemporaryDirectory(path));
}

/**
 * A live LaunchAgents directory plus a temporary config/log/cwd is how a test
 * or probe used to overwrite the user's helper with a job that dies when the
 * temp folder is deleted. Sandboxed agent directories may still write.
 */
export function refusesClobberingLiveHelper(input: {
  agentsDir: string;
  logPath: string;
  workingDirectory: string;
  configDirectory: string;
}): string | null {
  if (insideTemporaryDirectory(input.agentsDir)) return null;
  if (
    insideTemporaryDirectory(input.logPath)
    || insideTemporaryDirectory(input.workingDirectory)
    || insideTemporaryDirectory(input.configDirectory)
  ) {
    return CLOBBER_LIVE_HELPER_DETAIL;
  }
  return null;
}
