const MAX_CLOUD_RESPONSE_BYTES = 64 * 1024;

/** Bound connect and body-consumption time while composing parent cancellation. */
export async function fetchCloudJson<T>(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ response: Response; value: T }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    return { response, value: await readCloudJson<T>(response, controller.signal) };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function readCloudJson<T>(response: Response, signal: AbortSignal): Promise<T> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CLOUD_RESPONSE_BYTES) {
    await response.body?.cancel("response too large").catch(() => {});
    throw new Error("cloud response body too large");
  }
  if (!response.body) return {} as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel("aborted").catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CLOUD_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => {});
        throw new Error("cloud response body too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (total === 0) return {} as T;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return {} as T;
  }
}
