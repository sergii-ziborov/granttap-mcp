import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ControllerPairOffer, ControllerPairRequest } from "../../../../packages/protocol/schema";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

type Record = { requestId: string; requesterKey: string; offer: ControllerPairOffer };
type Transport = {
  room: string;
  addControllerPeer: (key: string) => void;
  sendToPeer: (offer: ControllerPairOffer, key: string) => Promise<void>;
};
type Mint = () => Promise<{ room: string; peerPublicKey: string; uri: string }>;

const pending = new Map<string, Promise<boolean>>();
let issuance = Promise.resolve();

function journalPath(): string { return join(configDir(), "controller-pair-offers.json"); }

function load(now: number): Record[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(journalPath(), "utf8"));
    if (!Array.isArray(parsed) || parsed.length > 16) return null;
    const valid = (value: unknown): value is Record => {
      if (!value || typeof value !== "object") return false;
      const record = value as Partial<Record>;
      return typeof record.requestId === "string" && typeof record.requesterKey === "string"
        && typeof record.offer?.expiresAt === "number" && typeof record.offer.uri === "string"
        && record.offer.status === "ready";
    };
    if (!parsed.every(valid)) return null;
    return parsed.filter((record: Record) => (record.offer.expiresAt ?? 0) > now);
  } catch { return existsSync(journalPath()) ? null : []; }
}

function persist(records: Record[]): void {
  writePrivateFile(journalPath(), `${JSON.stringify(records)}\n`);
}

function rejected(requestId: string, room: string, reason: string, now: number): ControllerPairOffer {
  return { type: "controller.pair.offer", requestId, room, status: "rejected", reason,
    createdAt: now };
}

async function issue(
  client: Transport, requesterKey: string, request: ControllerPairRequest, mint: Mint,
  now: number,
): Promise<boolean> {
  const records = load(now);
  let offer: ControllerPairOffer;
  if (!records) {
    offer = rejected(request.requestId, client.room, "Pairing journal needs repair on the computer.", now);
  } else {
    const prior = records.find((item) => item.requestId === request.requestId);
    if (prior && prior.requesterKey !== requesterKey) {
      offer = rejected(request.requestId, client.room, "This request belongs to another controller.", now);
    } else if (prior) {
      offer = prior.offer;
    } else if (Math.abs(now - request.createdAt) > 5 * 60_000) {
      offer = rejected(request.requestId, client.room, "Request expired. Try again.", now);
    } else {
      try {
        const created = await mint();
        if (created.room !== client.room) throw new Error("room changed");
        client.addControllerPeer(created.peerPublicKey);
        offer = { type: "controller.pair.offer", requestId: request.requestId,
          room: client.room, status: "ready", uri: created.uri,
          expiresAt: now + 15 * 60_000, createdAt: now };
        persist([...records, { requestId: request.requestId, requesterKey, offer }].slice(-16));
      } catch {
        offer = rejected(request.requestId, client.room, "Could not create a controller code.", now);
      }
    }
  }
  await client.sendToPeer(offer, requesterKey);
  return true;
}

/** Durable, scoped offer: a relay retry cannot mint a second controller key. */
export function issueControllerOffer(
  client: Transport, requesterKey: string, request: ControllerPairRequest, mint: Mint,
  now = Date.now(),
): Promise<boolean> {
  const id = `${client.room}:${request.requestId}`;
  const existing = pending.get(id);
  if (existing) return existing;
  const work = issuance.then(() => issue(client, requesterKey, request, mint, now));
  issuance = work.then(() => undefined, () => undefined);
  pending.set(id, work);
  void work.finally(() => { pending.delete(id); }).catch(() => undefined);
  return work;
}
