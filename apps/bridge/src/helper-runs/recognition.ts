/**
 * Whether a provider's headless session was a helper run.
 *
 * A generator's folder says so by its name. Any other run is known by what its
 * folder was: one linked to a chat while the run's process lived, or one a
 * script made for a single request, which is gone again or was made minutes
 * ago and is not a checkout of its own. A headless session in a workspace that
 * stays, or one that was given a second request, is a chat.
 */
import {
  freshRunFolder,
  helperRunFolder,
  helperRunLabel,
  plainFolder,
  vanishedRunFolder,
  type HelperRunFolder,
  type HelperRunKind,
} from "./kinds";
import { helperRunLink, type HelperRunLink } from "./links";

export type HeadlessSession = {
  cwd?: string;
  startedAt: number;
  /** How many requests the session was given; a run is given one. */
  requests: number;
  /** The checkout the provider recorded for the session, when it recorded one. */
  checkoutRoot?: string;
  /** Whether the session made a picture. */
  madePictures?: boolean;
};

export type RunFolderChecks = {
  link?: (folder: string) => HelperRunLink | undefined;
  vanished?: (folder: string, now: number) => boolean;
  fresh?: (folder: string, now: number) => boolean;
  now?: number;
};

/** A link names the run that was alive when it was captured, not a later session in a folder of the same name. */
const LINK_SLACK_MS = 60_000;

export function recognizeHelperRun(session: HeadlessSession, checks: RunFolderChecks = {}): HelperRunFolder | undefined {
  const generator = helperRunFolder(session.cwd);
  if (generator) return generator;
  if (!session.cwd) return undefined;
  const folder = plainFolder(session.cwd);
  const kind: HelperRunKind = session.madePictures ? "image-generation" : "helper-run";
  const run: HelperRunFolder = { kind, label: helperRunLabel(kind), folder };
  const link = (checks.link ?? helperRunLink)(folder);
  if (link && session.startedAt <= link.capturedAt + LINK_SLACK_MS) return run;
  if (session.requests > 1) return undefined;
  if (session.checkoutRoot && plainFolder(session.checkoutRoot) === folder) return undefined;
  const now = checks.now ?? Date.now();
  return (checks.vanished ?? vanishedRunFolder)(folder, now) || (checks.fresh ?? freshRunFolder)(folder, now)
    ? run : undefined;
}
