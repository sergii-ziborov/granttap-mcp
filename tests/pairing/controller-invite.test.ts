import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControllerPairOffer, ControllerPairRequest } from "../../packages/protocol/schema";
import { issueControllerOffer } from "../../apps/bridge/src/pairing/controller-invites";

test("controller request validates and a repeated request returns its original offer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-controller-invite-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; });
  const request = ControllerPairRequest.parse({
    type: "controller.pair.request", requestId: "9be4078b-b747-4298-a3cd-7e63f60524bc",
    createdAt: Date.now(),
  });
  assert.equal(ControllerPairRequest.safeParse({ ...request, requestId: "bad" }).success, false);
  const sent: Array<{ peer: string; offer: ControllerPairOffer }> = [];
  let issued = 0;
  const client = {
    room: "0123456789abcdef0123456789abcdef",
    addControllerPeer: () => {},
    sendToPeer: async (offer: ControllerPairOffer, peer: string) => { sent.push({ offer, peer }); },
  };
  const create = async () => {
    issued += 1;
    return { room: client.room, peerPublicKey: "new-controller-key",
      uri: "granttap://pair-v2?v=2&u=https%3A%2F%2Frelay.granttap.com&m=0123456789abcdef0123456789abcdef&k=key",
    };
  };
  await issueControllerOffer(client, "original-phone-key", request, create);
  await issueControllerOffer(client, "original-phone-key", request, create);
  assert.equal(issued, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.offer.uri, sent[1]?.offer.uri);
  assert.equal(sent[0]?.peer, "original-phone-key");
  assert.equal(ControllerPairOffer.safeParse(sent[0]?.offer).success, true);
  const journal = await readFile(join(root, "controller-pair-offers.json"), "utf8");
  assert.equal(journal.includes("original-phone-key"), true);
  assert.equal(journal.includes("new-controller-key"), false);
});

test("same request ID cannot transfer the invitation to another phone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-controller-invite-scope-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { delete process.env.GRANTTAP_CONFIG_DIR; });
  const request = ControllerPairRequest.parse({
    type: "controller.pair.request", requestId: "d584fe74-a7f2-4600-b3e3-33e6cf2e89c8",
    createdAt: Date.now(),
  });
  const sent: ControllerPairOffer[] = [];
  const client = {
    room: "0123456789abcdef0123456789abcdef",
    addControllerPeer: () => {},
    sendToPeer: async (offer: ControllerPairOffer) => { sent.push(offer); },
  };
  const create = async () => ({ room: client.room, peerPublicKey: "new-controller-key",
    uri: "granttap://pair-v2?v=2&u=x&m=y&k=z" });
  await issueControllerOffer(client, "phone-a", request, create);
  await issueControllerOffer(client, "phone-b", request, create);
  assert.equal(sent[1]?.status, "rejected");
  assert.equal(sent[1]?.uri, undefined);
});
