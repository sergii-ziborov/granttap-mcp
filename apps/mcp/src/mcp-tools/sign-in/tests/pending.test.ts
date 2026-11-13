import assert from "node:assert/strict";
import test from "node:test";
import type { SignInResult } from "../../../../../../packages/protocol/schema";
import { answersSignIn, type PendingSignIn } from "../pending";

const now = 1_800_000_000_000;

function pending(overrides: Partial<PendingSignIn> = {}): PendingSignIn {
  return {
    id: "a1b2c3d4e5f6a7b8", room: "room-a", sessionId: "chat", peers: new Set(["phone-key"]),
    callbackPort: 8976, expiresAt: now + 60_000, state: "waiting", ...overrides,
  };
}

function result(overrides: Partial<SignInResult> = {}): SignInResult {
  return {
    type: "signin.result", id: "a1b2c3d4e5f6a7b8", sessionId: "chat", outcome: "completed",
    callback: { path: "/cb", query: "code=1" }, createdAt: now, ...overrides,
  };
}

const sender = { room: "room-a", peerPublicKey: "phone-key" };

test("a result answers a sign-in only from a phone it was sent to, in its room and chat, in time, once", () => {
  assert.equal(answersSignIn(pending(), result(), sender, now), true);
  assert.equal(answersSignIn(pending(), result({ outcome: "cancelled", callback: undefined }), sender, now), true);

  assert.equal(answersSignIn(pending(), result({ id: "ffffffffffffffff" }), sender, now), false, "another request");
  assert.equal(answersSignIn(pending(), result(), { ...sender, peerPublicKey: "second-phone" }, now), false,
    "a controller paired after the request was sent never received it");
  assert.equal(answersSignIn(pending(), result(), { ...sender, room: "room-b" }, now), false, "another pairing");
  assert.equal(answersSignIn(pending(), result({ sessionId: "other-chat" }), sender, now), false);
  assert.equal(answersSignIn(pending(), result({ sessionId: undefined }), sender, now), false,
    "a request asked from a chat is answered for that chat");
  assert.equal(answersSignIn(pending({ sessionId: undefined }), result({ sessionId: undefined }), sender, now), true,
    "an unattributed request has no chat to match");
  assert.equal(answersSignIn(pending(), result(), sender, now + 60_000), false, "expired");
  assert.equal(answersSignIn(pending({ state: "settled" }), result(), sender, now), false, "already answered");
});
