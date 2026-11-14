/**
 * Which working folders belong to a generator's short helper run.
 *
 * A chat that asks for a picture runs a script, and the script starts its own
 * headless provider session in a throwaway folder inside the system temp
 * directory. The folder's name carries the generator's prefix; nothing else
 * about the run says what it is. A session in a temp folder is not a helper
 * run by itself: only a generator listed here makes it one.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export type HelperRunKind = "image-generation";

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

function plain(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
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

function isTempRoot(directory: string, roots: readonly string[]): boolean {
  return PER_USER_TEMP.test(directory) || roots.some((root) => plain(root) === directory);
}

/** The generator a working folder belongs to, when it is one's throwaway folder directly inside a temp directory. */
export function helperRunFolder(
  path: string | undefined,
  tempRoots: readonly string[] = systemTempRoots(),
): HelperRunFolder | undefined {
  if (!path) return undefined;
  const folder = plain(path);
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
 * A Mesh that was registered for a helper run's folder before helper runs were recognised.
 * A repository with a remote is a real Project wherever it was cloned.
 */
export function helperRunProject(project: { repositoryRoot?: string; canonicalRepositoryId: string }): boolean {
  const identity = project.canonicalRepositoryId;
  if (!identity.startsWith("local:")) return false;
  return helperRunFolder(project.repositoryRoot) !== undefined
    || helperRunFolder(identity.slice("local:".length)) !== undefined;
}
