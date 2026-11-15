/**
 * Which working folders belong to a generator's short helper run.
 *
 * A chat that asks for a picture runs a script, and the script starts its own
 * headless provider session in a throwaway folder inside the system temp
 * directory. The folder's name carries the generator's prefix; nothing else
 * about the run says what it is. A session in a temp folder is not a helper
 * run by itself: only a generator listed here makes it one.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

/** `helper-run` is a run no generator claims: its folder alone says it was made for one run. */
export type HelperRunKind = "image-generation" | "helper-run";

type Generator = {
  /** How the generator names its throwaway folder. */
  prefix: string;
  kind: HelperRunKind;
  /** What a phone that does not know the kind calls the run. */
  label: string;
};

/** Every generator, in one place: add a row to recognise another one. */
const GENERATORS: readonly Generator[] = [
  { prefix: "hw-image-", kind: "image-generation", label: "Image generation" },
];

const RUN_SUFFIX = /^[A-Za-z0-9_-]{4,64}$/;
/** macOS gives each person a temp directory of this shape, with or without `/private`. */
const PER_USER_TEMP = /^\/var\/folders\/[^/]+\/[^/]+\/T$/;

export type HelperRunFolder = {
  kind: HelperRunKind;
  label: string;
  /** The folder in one spelling, so a path read from a process and one read from a log compare equal. */
  folder: string;
};

/** A folder in one spelling: forward slashes, no trailing slash, and macOS `/private/var` as `/var`. */
export function plainFolder(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^\/private\/(var|tmp)(\/|$)/.test(trimmed) ? trimmed.slice("/private".length) : trimmed;
}

let ownTemp: readonly string[] | undefined;

/** This computer's temp directory, as the environment names it and as the disk does. */
function systemTempRoots(): readonly string[] {
  if (ownTemp) return ownTemp;
  const named = tmpdir();
  let resolved = named;
  try { resolved = realpathSync(named); } catch { /* The named path stands. */ }
  ownTemp = [named, resolved, "/tmp"];
  return ownTemp;
}

/** Whether a folder, in its plain spelling, is a temp directory of this computer. */
export function isTempRoot(directory: string, roots: readonly string[] = systemTempRoots()): boolean {
  return PER_USER_TEMP.test(directory) || roots.some((root) => plainFolder(root) === directory);
}

/** The generator a working folder belongs to, when it is one's throwaway folder directly inside a temp directory. */
export function helperRunFolder(
  path: string | undefined,
  tempRoots: readonly string[] = systemTempRoots(),
): HelperRunFolder | undefined {
  if (!path) return undefined;
  const folder = plainFolder(path);
  const cut = folder.lastIndexOf("/");
  if (cut <= 0 || !isTempRoot(folder.slice(0, cut), tempRoots)) return undefined;
  const name = folder.slice(cut + 1);
  const generator = GENERATORS.find((item) =>
    name.startsWith(item.prefix) && RUN_SUFFIX.test(name.slice(item.prefix.length)));
  return generator ? { kind: generator.kind, label: generator.label, folder } : undefined;
}

/** Every different generator folder a text names, such as a process's command line. */
export function helperRunFoldersNamed(text: string, tempRoots?: readonly string[]): HelperRunFolder[] {
  const found = new Map<string, HelperRunFolder>();
  for (const generator of GENERATORS) {
    const name = generator.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.matchAll(new RegExp(`/[A-Za-z0-9._/-]+/${name}[A-Za-z0-9_-]{4,64}`, "g"))) {
      const folder = helperRunFolder(match[0], tempRoots);
      if (folder) found.set(folder.folder, folder);
    }
  }
  return [...found.values()];
}

export function helperRunLabel(kind: string): string {
  return GENERATORS.find((item) => item.kind === kind)?.label ?? "Helper run";
}

/**
 * A Mesh that was registered for a helper run's folder before the run was recognised: a generator's
 * folder, or a folder made for one run that is gone again. A repository with a remote is a real
 * Project wherever it was cloned.
 */
export function helperRunProject(
  project: { repositoryRoot?: string; canonicalRepositoryId: string },
  vanished: (folder: string | undefined) => boolean = vanishedRunFolder,
): boolean {
  const identity = project.canonicalRepositoryId;
  if (!identity.startsWith("local:")) return false;
  const folders = [project.repositoryRoot, identity.slice("local:".length)];
  return folders.some((folder) => helperRunFolder(folder) !== undefined) || folders.some((folder) => vanished(folder));
}

/** A folder made this recently was made for the run found in it, when nothing else is there to work on. */
export const FRESH_FOLDER_MS = 15 * 60_000;
const CHECK_AGAIN_MS = 60_000;
const MAX_REMEMBERED = 4_096;
const vanishedChecks = new Map<string, { at: number; vanished: boolean }>();

function absolute(folder: string): boolean {
  return folder.startsWith("/") || /^[A-Za-z]:\//.test(folder);
}

function parentOf(folder: string): string | undefined {
  const cut = folder.lastIndexOf("/");
  if (cut < 0) return undefined;
  const parent = cut === 0 ? "/" : folder.slice(0, cut);
  return parent === folder || /^[A-Za-z]:$/.test(parent) ? undefined : parent;
}

/**
 * A folder that was made for one run and removed after it: it is gone, and it lay directly inside a
 * temp directory or anywhere inside a Git checkout. Had it been a workspace of its own it would have
 * been that checkout's. The answer is kept for a minute; a Mesh list asks about every Project.
 */
export function vanishedRunFolder(path: string | undefined, now = Date.now()): boolean {
  if (!path) return false;
  const folder = plainFolder(path);
  if (!absolute(folder)) return false;
  const known = vanishedChecks.get(folder);
  if (known && now - known.at < CHECK_AGAIN_MS && now >= known.at) return known.vanished;
  let vanished = false;
  try {
    if (!existsSync(folder)) {
      let above = parentOf(folder);
      vanished = above !== undefined && isTempRoot(above);
      for (let depth = 0; !vanished && above !== undefined && depth < 48; depth += 1) {
        vanished = existsSync(`${above === "/" ? "" : above}/.git`);
        above = parentOf(above);
      }
    }
  } catch { /* A folder that cannot be looked at is not called gone. */ }
  if (vanishedChecks.size >= MAX_REMEMBERED) vanishedChecks.clear();
  vanishedChecks.set(folder, { at: now, vanished });
  return vanished;
}

/** For tests: look at every folder again. */
export function forgetRunFolderChecks(): void {
  vanishedChecks.clear();
}

/** A folder made within the last minutes that is not a checkout of its own: a script made it for the run in it. */
export function freshRunFolder(path: string | undefined, now = Date.now()): boolean {
  if (!path) return false;
  const folder = plainFolder(path);
  if (!absolute(folder) || isTempRoot(folder)) return false;
  try {
    const stat = statSync(folder);
    if (!stat.isDirectory() || !(stat.birthtimeMs > 0) || now - stat.birthtimeMs > FRESH_FOLDER_MS) return false;
    return !existsSync(`${folder}/.git`);
  } catch {
    return false;
  }
}
