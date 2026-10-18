import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from "node:path";
import { MAX_USER_ATTACHMENTS, type UserAttachment } from "../../../../../packages/protocol/schema";
import type { ReplyResult } from "./types";
import { configDir } from '../../config';

type PreparedAttachments = { prompt: string; claudePrompt: string; images: string[] };

export async function withAttachments(
  attachments: UserAttachment[],
  text: string,
  run: (prepared: PreparedAttachments) => Promise<ReplyResult>,
): Promise<ReplyResult> {
  if (attachments.length === 0) return run({ prompt: text, claudePrompt: text, images: [] });
  const root = join(configDir(), 'message-attachments');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "granttap-attachments-"));
  let retained = false;
  try {
    const files = await writeAttachments(directory, attachments);
    const documents = files.filter((file) => !file.image);
    const documentNote = documents.length === 0 ? "" : `\n\nAttached files available locally:\n${documents.map(fileLine).join("\n")}`;
    const claudeNote = `\n\nAttached files available locally (inspect them as part of this request):\n${files.map(fileLine).join("\n")}`;
    const result = await run({
      prompt: `${text || "Please inspect the attached content."}${documentNote}`,
      claudePrompt: `${text || "Please inspect the attached content."}${claudeNote}`,
      images: files.filter((file) => file.image).map((file) => file.path),
    });
    retained = result.delivery === 'native' && documents.length > 0;
    return result;
  } catch (error) {
    return { ok: false, error: `Could not prepare attachment: ${(error as Error).message}` };
  } finally {
    if (!retained) await rm(directory, { recursive: true, force: true });
  }
}

/** Native admission returns before the agent reads documents. Retain those for one day. */
export function prunePreparedAttachments(now = Date.now()): number {
  const root = join(configDir(), 'message-attachments');
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^granttap-attachments-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    try {
      const path = join(root, entry.name);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mtimeMs > now - 86_400_000) continue;
      rmSync(path, { recursive: true, force: true });
      count++;
    } catch { /* A concurrent delivery may already have removed its own stage. */ }
  }
  return count;
}

type StagedFile = { path: string; image: boolean; name: string };

async function writeAttachments(directory: string, attachments: UserAttachment[]): Promise<StagedFile[]> {
  const files: StagedFile[] = [];
  for (const [index, attachment] of attachments.slice(0, MAX_USER_ATTACHMENTS).entries()) {
    const name = basename(attachment.name).replace(/[^\p{L}\p{N}._ -]/gu, "_") || `attachment-${index + 1}`;
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.length > 6_000_000) throw new Error(`${name} is larger than 6 MB.`);
    const path = join(directory, `${index + 1}-${name}`);
    await writeFile(path, bytes, { mode: 0o600 });
    files.push({ path, image: attachment.mimeType.startsWith("image/"), name });
  }
  return files;
}

function fileLine(file: StagedFile): string {
  return `- ${file.name}: ${file.path}`;
}
