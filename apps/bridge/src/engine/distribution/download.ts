import { createHash } from "node:crypto";
import { engineArtifactName, type EngineArtifact } from "./artifacts";

/** Fixed-origin, size-bounded, checksum-pinned download with no cookies or redirects. */
export async function downloadEngine(artifact: EngineArtifact, fetcher: typeof fetch): Promise<Buffer> {
  const url = `https://granttap.com/downloads/engine/${artifact.version}/${engineArtifactName(artifact)}`;
  const response = await fetcher(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(45_000) });
  if (!response.ok || response.redirected) throw new Error("Verified Engine download is unavailable");
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== artifact.bytes) throw new Error("Engine download size is invalid");
  if (!response.body) throw new Error("Engine download is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      if (received > artifact.bytes) throw new Error("Engine download exceeds its size limit");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("Engine download checksum mismatch");
  }
  return bytes;
}
