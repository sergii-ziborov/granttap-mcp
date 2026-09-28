import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generateKeyPair, open } from "../../../../../packages/core/crypto";
import { applyNetworkRoute, readNetworkSettings, writeNetworkSettings } from "../settings";
import { saveConfig } from "../../config/access/pairing";
import { machineConfigPath } from "../../config/runtime/paths";
import { rememberPendingController } from "../../pairing/controllers";
import { publishEndpoint } from "../directory";

test("direct settings survive restart without replacing pairing identity or secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-device-network-"));
  const path = join(root, "network.json");
  const pairing = { relayUrl: "wss://relay.granttap.com", room: "aa".repeat(16),
    role: "machine" as const, deviceName: "test", senderId: "id", myPublicKey: "pub",
    mySecretKey: "secret", peerPublicKey: "peer", pushAuth: "bb".repeat(32) };
  assert.equal(applyNetworkRoute(pairing, path), pairing);
  writeNetworkSettings({ mode: "direct", endpoint: "wss://mac.example:443", port: 3201 }, path);
  assert.deepEqual(readNetworkSettings(path), {
    mode: "direct", endpoint: "wss://mac.example", port: 3201,
  });
  const configured = applyNetworkRoute(pairing, path);
  assert.equal(configured.relayUrl, "wss://mac.example");
  assert.equal(configured.directoryUrl, "wss://relay.granttap.com");
  assert.equal(configured.room, pairing.room);
  assert.equal(configured.mySecretKey, pairing.mySecretKey);
  assert.equal(pairing.relayUrl, "wss://relay.granttap.com");
  assert.equal(readFileSync(path, "utf8").includes("secret"), false);
  writeNetworkSettings({ mode: "selfHosted", endpoint: "wss://own.example", port: 3202 }, path);
  assert.equal(applyNetworkRoute(pairing, path).directoryUrl, undefined);
  assert.equal(readNetworkSettings(path).mode, "selfHosted");
});

test("bad network configuration is refused and never replaces an earlier valid route", () => {
  const path = join(mkdtempSync(join(tmpdir(), "granttap-network-invalid-")), "network.json");
  const valid = { mode: "direct", endpoint: "wss://mac.example", port: 3201 };
  writeNetworkSettings(valid, path);
  for (const endpoint of ["http://mac.example", "ws://192.168.1.1", "wss://a:b@mac.example",
    "wss://mac.example?token=secret", "wss://mac.example/#bad", "not a URL"]) {
    assert.throws(() => writeNetworkSettings({ ...valid, endpoint }, path));
  }
  assert.throws(() => writeNetworkSettings({ ...valid, port: 0 }, path));
  assert.deepEqual(readNetworkSettings(path), valid);
  writeFileSync(path, "invalid JSON");
  assert.throws(() => readNetworkSettings(path));
});

test("directory announcements encrypt each controller's endpoint and bound its lifetime", async () => {
  const machine = generateKeyPair(), phone = generateKeyPair(), other = generateKeyPair();
  const requests: { url: URL; body: any; headers: Record<string, string> }[] = [];
  const config = { relayUrl: "wss://mac.example", directoryUrl: "wss://relay.granttap.com",
    room: "ab".repeat(16), role: "machine" as const, senderId: "machine", deviceName: "test",
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey, extraPeerPublicKeys: [other.publicKey], pushAuth: "cd".repeat(32) };
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-directory-peers-"));
  saveConfig(machineConfigPath(), config);
  rememberPendingController(config.room, other.publicKey, Date.now() + 300_000);
  await publishEndpoint(config, async (url, init) => {
    requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string> });
    return new Response("{}", { status: 200 });
  }, 1_000_000);
  assert.equal(requests.length, 2);
  for (const [index, secret] of [phone.secretKey, other.secretKey].entries()) {
    const request = requests[index]!;
    assert.equal(request.url.origin, "https://relay.granttap.com");
    assert.equal(request.url.pathname, "/endpoint");
    assert.equal(request.url.searchParams.get("room"), config.room);
    assert.equal(request.url.searchParams.get("recipient")?.length, 64);
    assert.equal(JSON.stringify(request.body).includes("mac.example"), false);
    assert.deepEqual(open(request.body.nonce, request.body.box, machine.publicKey, secret), {
      schema: "granttap.direct-endpoint.v1", relayUrl: config.relayUrl,
      room: config.room, expiresAt: 1_600_000,
    });
    assert.equal(request.body.expiresAt, 1_600_000);
  }
  await assert.rejects(publishEndpoint(config, async () => new Response("{}", { status: 401 })), /refused/);
});
