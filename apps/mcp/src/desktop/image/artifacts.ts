import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, existsSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { join } from "node:path";

export type ArtifactImage = { id: string; name: string; markdown: string; path: string };

/** Recognise explicit local image links, excluding Markdown code examples. */
export function artifactImages(entry: { id: string; text: string; kind: string }): ArtifactImage[] {
  if (!["message", "final", "user"].includes(entry.kind)) return [];
  const visible = entry.text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*/g,
    (code) => " ".repeat(code.length)).replace(/(`+)[^\n]*?\1/g, (code) => " ".repeat(code.length));
  const images: ArtifactImage[] = [];
  const seen = new Set<string>();
  for (const match of visible.matchAll(/!?\[([^\]\n]{0,256})\]\(/g)) {
    if (images.length >= 32) break;
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    for (; end < visible.length && end - start <= 2_048; end++) {
      if (visible[end] === "\\") { end++; continue; }
      if (visible[end] === "(") depth++;
      if (visible[end] === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const target = visible.slice(start, end).trim().replace(/\s+["'][^"']*["']$/, "");
    const path = localImagePath(target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 24);
    images.push({ id: `${entry.id}:image:${hash}`, name: basename(path), path,
      markdown: entry.text.slice(match.index, end + 1) });
  }
  return images;
}

function localImagePath(target: string): string | undefined {
  try {
    const path = target.startsWith("file:") ? fileURLToPath(target)
      : /^[a-z][a-z\d+.-]*:/i.test(target) ? undefined
      : decodeURIComponent(target.replace(/\\([\\()])/g, "$1"));
    return path && !/[\u0000-\u001f]/.test(path) && /\.(?:png|jpe?g|webp)$/i.test(path) ? path : undefined;
  } catch { return undefined; }
}

/** Read only a linked image inside the exact native Execution's workspace. */
export function artifactImageChunk(input: {
  projectId: string; taskId: string; sessionId: string; provider: string;
  image: ArtifactImage; offset: number; storePath?: string;
}) {
  const loaded = readStoreState(input.storePath ?? join(configDir(), "project-mesh.json"));
  if (loaded.status !== "ok") return undefined;
  const tasks = loaded.state.tasks.filter((task) => task.taskId === input.taskId);
  if (tasks.length !== 1 || tasks[0]?.projectId !== input.projectId) return undefined;
  const execution = loaded.state.executions.find((link) => link.taskId === input.taskId
    && link.sessionId === input.sessionId && link.provider === input.provider);
  if (!execution?.workspace) return undefined;
  let fd: number | undefined;
  try {
    const workspace = realpathSync(execution.workspace);
    const requested = resolve(workspace, input.image.path);
    const resolved = existingImagePath(requested);
    if (!resolved) return undefined;
    const path = realpathSync(resolved);
    const child = relative(workspace, path);
    if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) return undefined;
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= input.offset || stat.size > 8 * 1024 * 1024) return undefined;
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, header.length, 0);
    const mime = imageMime(header);
    if (!mime) return undefined;
    const bytes = Buffer.alloc(Math.min(64 * 1024, stat.size - input.offset));
    if (readSync(fd, bytes, 0, bytes.length, input.offset) !== bytes.length) return undefined;
    return { mime_type: mime, total_bytes: stat.size, offset: input.offset, data_base64: bytes.toString("base64") };
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function imageMime(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** A format conversion keeps the filename stem. Never choose an ambiguous sibling. */
function existingImagePath(path: string): string | undefined {
  if (existsSync(path)) return path;
  const stem = path.slice(0, -extname(path).length);
  const siblings = [".png", ".jpg", ".jpeg", ".webp"]
    .map((extension) => stem + extension).filter((candidate) => existsSync(candidate));
  return siblings.length === 1 ? siblings[0] : undefined;
}
