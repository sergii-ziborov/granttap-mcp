import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import type { SessionActivity, SessionInfo } from "../../../../../../packages/protocol/schema";
import { SessionInfo as SessionSchema } from "../../../../../../packages/protocol/schema";
import {
  attachChatPictures, forgetChatPictures, keepNotedChatPictures, noteChatPictureHints, pictureSavedText, savedPictures,
  withChatPictures, type ChatPictureHint,
} from "../chats";
import { chatPictures, helperRunPictureChunk, keepHelperRunPicture, pictureHash } from "../store";

const CHAT = "image-chat-0001";
const PARENT = "parent-chat-0001";

function png(seed: number): Buffer {
  const crc = (bytes: Buffer) => {
    let value = ~0;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
    return ~value >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(14, seed))), chunk("IEND", Buffer.alloc(0))]);
}

function folders(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-chat-pictures-")));
  const work = join(root, "work"), outside = join(root, "outside"), home = join(root, "home");
  for (const folder of [join(work, "out"), outside, home]) mkdirSync(folder, { recursive: true });
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    forgetChatPictures();
    rmSync(root, { recursive: true, force: true });
  });
  return { work, outside, home };
}

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: CHAT, agent: "codex", state: "idle",
  startedAt: 1, lastActivityAt: Date.now(), tokensSession: 0, tokensLastTurn: 0, ...overrides });

test("only an image file the answer names inside the chat's own folder, written in this turn, is its picture", (t) => {
  const { work, outside, home } = folders(t);
  const since = Date.now() - 60_000;
  writeFileSync(join(work, "out", "harbour.png"), png(1));
  writeFileSync(join(work, "notes.txt"), "not a picture");
  writeFileSync(join(work, "old.png"), png(2));
  utimesSync(join(work, "old.png"), (since - 3_600_000) / 1000, (since - 3_600_000) / 1000);
  writeFileSync(join(outside, "secret.png"), png(3));
  symlinkSync(join(outside, "secret.png"), join(work, "link.png"));
  const answer = [`Saved to \`${join(work, "out", "harbour.png")}\`.`, "Also out/harbour.png, notes.txt, old.png,",
    `link.png, ${join(outside, "secret.png")}, ![x](missing.png) and file://${join(work, "out", "harbour.png")}`].join("\n");
  assert.deepEqual(savedPictures(answer, work, since, home), [
    { path: join(work, "out", "harbour.png"), source: join(work, "out", "harbour.png") }]);
  assert.deepEqual(savedPictures("out/harbour.png", work, since, home), [
    { path: join(work, "out", "harbour.png"), source: "out/harbour.png" }]);
  assert.deepEqual(savedPictures(`${home}/a.png`, home, since, home), [], "the home folder is no working folder");
  assert.deepEqual(savedPictures("/a.png", "/", since, home), []);
  assert.deepEqual(savedPictures(undefined, work, since, home), []);
  assert.deepEqual(savedPictures("x.png", "relative", since, home), []);
  assert.equal(pictureSavedText([{ path: "/w/a.png" }]), "Picture saved: a.png");
  assert.equal(pictureSavedText([], "ig_1.png"), "Picture saved: ig_1.png");
  assert.equal(pictureSavedText([1, 2, 3, 4, 5].map((n) => ({ path: `/w/${n}.png` }))),
    "Picture saved: 1.png, 2.png, 3.png and 2 more");
  assert.equal(pictureSavedText([]), undefined);
});

test("the monitor keeps a chat's picture once; the chat and the chat that started it can read it", async (t) => {
  const { work, outside } = folders(t);
  const path = join(work, "out", "harbour.png");
  writeFileSync(path, png(4));
  writeFileSync(join(work, "out", "fake.png"), "not an image at all");
  const hint: ChatPictureHint = { agent: "codex", sessionId: CHAT, cwd: work, at: Date.now(),
    pictures: [{ path, source: path }, { path: join(work, "out", "fake.png"), source: "out/fake.png" },
      { path: join(outside, "gone.png"), source: "gone.png" }] };
  noteChatPictureHints([hint, { ...hint, sessionId: "too-old-chat-01", at: Date.now() - 3 * 86_400_000 }]);
  let reduced = 0;
  const reduce = async (bytes: Uint8Array, mime: "image/png" | "image/jpeg" | "image/webp") => { reduced++; return { bytes, mime }; };
  await keepNotedChatPictures({ reduce });
  await keepNotedChatPictures({ reduce });
  assert.equal(reduced, 1, "a file is read once in each size and time it has");
  const kept = chatPictures({ agent: "codex", sessionId: CHAT });
  assert.deepEqual(kept.map((picture) => [picture.name, picture.source, picture.hash]), [["harbour.png", path, pictureHash(png(4))]]);
  assert.deepEqual(chatPictures({ agent: "codex", sessionId: "too-old-chat-01" }), []);

  const [card] = attachChatPictures([session(), session({ sessionId: "other-chat-001" })]);
  assert.equal(card!.images?.length, 1);
  assert.equal(SessionSchema.parse(card).images?.[0]?.name, "harbour.png");
  const id = card!.images![0]!.id;
  const parentOf = () => ({ sessionId: PARENT });
  assert.ok(helperRunPictureChunk(CHAT, id, 0, undefined, () => undefined));
  assert.ok(helperRunPictureChunk(PARENT, id, 0, undefined, parentOf));
  assert.equal(helperRunPictureChunk("stranger-chat-1", id, 0, undefined, parentOf), undefined);

  const activity: SessionActivity = { type: "session.activity", sessionId: CHAT, agent: "codex", state: "idle", generatedAt: 1,
    entries: [{ id: "q", kind: "user", text: "Draw a harbour.", createdAt: 1 },
      { id: "a", kind: "final", text: path, createdAt: 2 }] };
  const shown = withChatPictures(activity, session());
  assert.deepEqual(shown.entries[1]!.images, [{ id, name: "harbour.png", markdown: path }]);
  assert.deepEqual(withChatPictures(shown, session()).entries[1]!.images?.length, 1, "shown once");
  const agentPage = { ...activity, threadId: "agent" };
  assert.equal(withChatPictures(agentPage, session()), agentPage, "an agent conversation of the chat is left alone");
  assert.deepEqual(withChatPictures({ ...activity, entries: [activity.entries[0]!] }, session()).entries[0]!.images, undefined);
  assert.equal(withChatPictures(activity, undefined), activity);
});

test("a chat's kept pictures and a helper run's stay apart in one index", (t) => {
  folders(t);
  const bytes = png(5), hash = pictureHash(bytes);
  const picture = { hash, name: "a.png", source: "/w/a.png", mime: "image/png" as const, capturedAt: Date.now() };
  assert.equal(keepHelperRunPicture("/w", picture, bytes, Date.now(), { agent: "codex", sessionId: CHAT }), true);
  assert.equal(keepHelperRunPicture("/w", picture, bytes, Date.now(), { agent: "codex", sessionId: CHAT }), false);
  assert.equal(keepHelperRunPicture("/w", picture, bytes, Date.now(), { agent: "codex", sessionId: "x" }), false);
  assert.equal(keepHelperRunPicture("/var/folders/ab/c0ffee123/T/hw-image-abcd1234", picture, bytes), true);
  assert.equal(chatPictures({ agent: "codex", sessionId: CHAT }).length, 1);
  assert.equal(chatPictures({ agent: "claude", sessionId: CHAT }).length, 0);
});
