import { createHash } from "node:crypto";
import { seal, peerPublicKeys } from "../../../../packages/core/crypto";
import { controllerPeerGate } from "../pairing/controllers";
import type { PeerConfig } from "../../../../packages/core/relay-client";

export async function publishEndpoint(config: PeerConfig, fetcher = fetch, now = Date.now()): Promise<void> {
  if (!config.directoryUrl || config.role !== "machine" || !config.pushAuth) return;
  const base = new URL(config.directoryUrl);
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  base.pathname = "/endpoint";
  const expiresAt = now + 10 * 60 * 1_000;
  for (const peer of peerPublicKeys(config.peerPublicKey, config.extraPeerPublicKeys).filter(controllerPeerGate(config))) {
    const url = new URL(base);
    url.searchParams.set("room", config.room);
    url.searchParams.set("recipient", createHash("sha256").update(`${peer}:${config.myPublicKey}`).digest("hex"));
    const payload = seal({ schema: "granttap.direct-endpoint.v1", relayUrl: config.relayUrl,
      room: config.room, expiresAt }, peer, config.mySecretKey);
    const response = await fetcher(url, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.pushAuth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, expiresAt }) });
    if (!response.ok) throw new Error("Endpoint directory refused the announcement");
  }
}

export function startEndpointPublisher(config: PeerConfig): () => void {
  if (!config.directoryUrl) return () => {};
  let stopped = false;
  let busy = false;
  const publish = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await publishEndpoint(config); } catch { /* retry without changing transport */ }
    finally { busy = false; }
  };
  void publish();
  const timer = setInterval(() => void publish(), 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
