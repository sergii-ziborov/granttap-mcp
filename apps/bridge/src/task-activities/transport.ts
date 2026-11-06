import type { PeerConfig } from '../../../../packages/core/relay-client';

export type ActivityHTTP = (path: 'subscriptions' | 'update', body?: unknown) => Promise<unknown>;

/** Never follow an HTTP redirect with the room credential. Responses and time are bounded. */
export function activityHTTP(config: PeerConfig, request: typeof fetch = fetch): ActivityHTTP {
  return async (path, body) => {
    if (!config.pushAuth) return null;
    const url = new URL(config.relayUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.pathname = `/push/activity/${path}`;
    url.search = new URLSearchParams({room: config.room}).toString(); url.hash = '';
    const response = await request(url, {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: {Authorization: `Bearer ${config.pushAuth}`, 'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(8_000), body: body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 24_000) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
}
