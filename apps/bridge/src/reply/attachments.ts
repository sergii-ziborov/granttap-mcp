import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { UserAttachment } from "../../../../packages/protocol/schema";
import type { ReplyResult } from "./types";

type PreparedAttachments = { prompt: string; claudePrompt: string; images: string[] };

export async function withAttachments(
  attachments: UserAttachment[],
  text: string,
  run: (prepared: PreparedAttachments) => Promise<ReplyResult>,
): Promise<ReplyResult> {
  if (attachments.length === 0) return run({ prompt: text, claudePrompt: text, images: [] });
  const directory = await mkdtemp(join(tmpdir(), "granttap-attachments-"));
  try {
    const files = await writeAttachments(directory, attachments);
    const documents = files.filter((file) => !file.image);
    const documentNote = documents.length === 0 ? "" : `\n\nAttached files available locally:\n${documents.map(fileLine).join("\n")}`;
    const claudeNote = `\n\nAttached files available locally (inspect them as part of this request):\n${files.map(fileLine).join("\n")}`;
    return await run({
      prompt: `${text || "Please inspect the attached content."}${documentNote}`,
      claudePrompt: `${text || "Please inspect the attached content."}${claudeNote}`,
      images: files.filter((file) => file.image).map((file) => file.path),
    });
  } catch (error) {
    return { ok: false, error: `Could not prepare attachment: ${(error as Error).message}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type StagedFile = { path: string; image: boolean; name: string };

async function writeAttachments(directory: string, attachments: UserAttachment[]): Promise<StagedFile[]> {
  const files: StagedFile[] = [];
  for (const [index, attachment] of attachments.slice(0, 5).entries()) {
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
