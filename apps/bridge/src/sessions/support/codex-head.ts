import { closeSync, openSync, readSync } from "node:fs";
import { visibleUserText } from "./activity-helpers";
import { ts } from "./common";

const TITLE_HEAD_BYTES = 256 * 1024;

export type CodexHeadRequest = { text: string; createdAt: number };

function jsonStringAfter(source: string, key: string, offset = 0): string | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"`, "g");
  pattern.lastIndex = offset;
  const match = pattern.exec(source);
  if (!match) return undefined;
  const quote = match.index + match[0].length - 1;
  for (let index = quote + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] !== '"') continue;
    try {
      const value = JSON.parse(source.slice(quote, index + 1));
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function visibleResponseText(line: string): string | undefined {
  const input = /"type"\s*:\s*"(?:input_text|text)"/g;
  for (let match = input.exec(line); match; match = input.exec(line)) {
    const value = jsonStringAfter(line, "text", match.index + match[0].length);
    const visible = visibleUserText(value);
    if (visible) return visible;
  }
  return undefined;
}

function visibleText(line: string): string | undefined {
  if (/"type"\s*:\s*"event_msg"/.test(line)
      && /"type"\s*:\s*"user_message"/.test(line)) {
    const visible = visibleUserText(
      jsonStringAfter(line, "message") ?? jsonStringAfter(line, "text"),
    );
    if (visible) return visible;
  }
  if (/"type"\s*:\s*"response_item"/.test(line)
      && /"role"\s*:\s*"user"/.test(line)) {
    return visibleResponseText(line);
  }
  return undefined;
}

/** Recover the text prefix of an oversized first user row without reading its image bytes. */
export function codexHeadRequest(path: string): CodexHeadRequest | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(TITLE_HEAD_BYTES);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, count).toString("utf8");
    for (const line of source.split("\n")) {
      const text = visibleText(line);
      if (!text) continue;
      return { text, createdAt: ts(jsonStringAfter(line, "timestamp")) };
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
