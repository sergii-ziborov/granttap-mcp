import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../../packages/protocol/schema";
import { ChildThreadInfo as ChildThreadSchema } from "../../../../../packages/protocol/schema";
import { attachHelperRuns, helperRunEntries } from "../attach";
import { createHelperRunCapture } from "../capture";
import type { HelperRunLink } from "../links";
import { createPictureFollower, parseSipsSize, reducePicture } from "../pictures/capture";
import {
  helperRunImageId, helperRunPictureChunk, helperRunPictures, isHelperRunImageId, keepHelperRunPicture,
  pictureComplete, pictureHash, pictureMime, picturesDirectory,
} from "../pictures/store";

const FOLDER = "/var/folders/ab/c0ffee123/T/hw-image-abcd1234";
const PARENT = "parent-chat-0001";

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A real PNG; `noise` makes it large enough to be reduced. */
function png(width: number, height: number, noise = false): Buffer {
  const rows: Buffer[] = [];
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width * 3; x++) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      row[1 + x] = noise ? seed >>> 24 : (x + y) % 256;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function configured(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-run-pictures-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const linkTo = (parentSessionId: string) => (folder: string): HelperRunLink =>
  ({ folder, kind: "image-generation", parentAgent: "claude", parentSessionId, capturedAt: 1 });

async function until(check: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

test("a picture is recognised by its first bytes and is whole only once written to its end", () => {
  const whole = png(4, 3);
  assert.equal(pictureMime(whole), "image/png");
  assert.equal(pictureComplete(whole, "image/png"), true);
  assert.equal(pictureComplete(whole.subarray(0, whole.length - 5), "image/png"), false);
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 1, 2, 3, 255, 217]);
  assert.equal(pictureMime(jpeg), "image/jpeg");
  assert.equal(pictureComplete(jpeg, "image/jpeg"), true);
  assert.equal(pictureComplete(jpeg.subarray(0, 9), "image/jpeg"), false);
  const webp = Buffer.alloc(20);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(12, 4);
  webp.write("WEBP", 8, "ascii");
  assert.equal(pictureMime(webp), "image/webp");
  assert.equal(pictureComplete(webp, "image/webp"), true);
  assert.equal(pictureComplete(webp.subarray(0, 16), "image/webp"), false);
  assert.equal(pictureMime(Buffer.from("GIF89a")), undefined);
});

test("a kept picture is read back in bounded chunks by the chat that started its run, and by no other", (t) => {
  configured(t);
  const bytes = png(300, 300, true);
  const hash = pictureHash(bytes);
  assert.ok(bytes.length > 64 * 1024, "the fixture spans more than one chunk");
  assert.equal(keepHelperRunPicture(FOLDER, { hash, name: "image.png", source: `${FOLDER}/image.png`,
    mime: "image/png", capturedAt: Date.now() }, bytes), true);
  assert.equal(keepHelperRunPicture(FOLDER, { hash, name: "image.png", source: `${FOLDER}/image.png`,
    mime: "image/png", capturedAt: Date.now() }, bytes), false, "the same picture is kept once");
  assert.deepEqual(helperRunPictures(FOLDER).map((item) => [item.name, item.bytes]), [["image.png", bytes.length]]);

  const id = helperRunImageId(FOLDER, hash);
  assert.equal(isHelperRunImageId(id), true);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const chunk = helperRunPictureChunk(PARENT, id, offset, linkTo(PARENT));
    assert.ok(chunk);
    assert.equal(chunk.total_bytes, bytes.length);
    const data = Buffer.from(chunk.data_base64, "base64");
    assert.ok(data.length <= 64 * 1024);
    parts.push(data);
    offset += data.length;
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal(helperRunPictureChunk("another-chat-01", id, 0, linkTo(PARENT)), undefined);
  assert.equal(helperRunPictureChunk(PARENT, id, 0, () => undefined), undefined, "a run without a known parent shows nobody");
  assert.equal(helperRunPictureChunk(PARENT, id, bytes.length, linkTo(PARENT)), undefined);
  assert.equal(helperRunPictureChunk(PARENT, id, -1, linkTo(PARENT)), undefined);
  assert.equal(helperRunPictureChunk(PARENT, `helper-image:${"0".repeat(24)}:${hash}`, 0, linkTo(PARENT)), undefined);
  assert.equal(helperRunPictureChunk(PARENT, "helper-image:../../etc/passwd", 0, linkTo(PARENT)), undefined);
});

test("a picture that is not what it claims to be, or too large, is not kept", (t) => {
  configured(t);
  const bytes = png(2, 2);
  const base = { hash: pictureHash(bytes), name: "a.png", source: `${FOLDER}/a.png`, capturedAt: Date.now() };
  assert.equal(keepHelperRunPicture(FOLDER, { ...base, mime: "image/jpeg" }, bytes), false);
  assert.equal(keepHelperRunPicture(FOLDER, { ...base, hash: "not-a-hash", mime: "image/png" }, bytes), false);
  assert.equal(keepHelperRunPicture(FOLDER, { ...base, mime: "image/png" }, Buffer.alloc(0)), false);
  assert.deepEqual(helperRunPictures(FOLDER), []);
});

test("old runs are let go with their files, and an unreadable index keeps nothing", (t) => {
  configured(t);
  const now = Date.now();
  const old = png(2, 2), fresh = png(3, 3);
  const folder = (name: string) => `/var/folders/ab/c0ffee123/T/hw-image-${name}`;
  keepHelperRunPicture(folder("old0001"), { hash: pictureHash(old), name: "o.png", source: "o", mime: "image/png",
    capturedAt: now - 400 * 24 * 60 * 60 * 1000 }, old, now);
  keepHelperRunPicture(folder("new0001"), { hash: pictureHash(fresh), name: "n.png", source: "n", mime: "image/png",
    capturedAt: now }, fresh, now);
  assert.deepEqual(helperRunPictures(folder("old0001")), []);
  assert.equal(helperRunPictures(folder("new0001")).length, 1);
  assert.deepEqual(readdirSync(picturesDirectory()).filter((name) => name.endsWith(".png")).length, 1);
  writeFileSync(join(picturesDirectory(), "index.json"), "{ not json");
  assert.deepEqual(helperRunPictures(folder("new0001")), []);
});

test("a run's folder is followed while it lives: each finished picture is kept once, after the folder is gone too", async (t) => {
  const root = configured(t);
  const folder = join(root, "hw-image-live0001");
  mkdirSync(join(folder, "nested"), { recursive: true });
  const picture = png(40, 30);
  const reduced: number[] = [];
  const follower = createPictureFollower({
    reduce: async (bytes, mime) => { reduced.push(bytes.length); return { bytes, mime }; },
    watchFolder: () => undefined,
  });
  writeFileSync(join(folder, "image.png"), picture.subarray(0, picture.length - 8));
  writeFileSync(join(folder, "notes.txt"), "not a picture");
  follower.follow([folder]);
  await follower.settled();
  assert.deepEqual(helperRunPictures(folder), [], "a picture still being written waits");

  writeFileSync(join(folder, "image.png"), picture);
  writeFileSync(join(folder, "nested", "second.png"), png(8, 8));
  follower.follow([folder]);
  follower.follow([folder]);
  await follower.settled();
  rmSync(folder, { recursive: true, force: true });
  const kept = helperRunPictures(folder);
  assert.deepEqual(kept.map((item) => [item.name, item.source]).sort(),
    [["image.png", `${folder}/image.png`], ["second.png", `${folder}/nested/second.png`]]);
  assert.equal(reduced.length, 2, "each picture is read and reduced once");
  assert.deepEqual(follower.following(), [folder]);
  follower.follow([]);
  assert.deepEqual(follower.following(), []);
});

test("a picture written while the run is followed is caught by the watch, before the next sample", async (t) => {
  const root = configured(t);
  const folder = join(root, "hw-image-watch001");
  mkdirSync(folder);
  const follower = createPictureFollower({ reduce: async (bytes, mime) => ({ bytes, mime }) });
  follower.follow([folder]);
  t.after(() => follower.follow([]));
  writeFileSync(join(folder, "image.png"), png(16, 9));
  await until(() => helperRunPictures(folder).length > 0);
  await follower.settled();
  assert.equal(helperRunPictures(folder).length, 1);
});

test("a picture that cannot be reduced is not kept, and a missing folder is not an error", async (t) => {
  const root = configured(t);
  const folder = join(root, "hw-image-fail0001");
  mkdirSync(folder);
  writeFileSync(join(folder, "image.png"), png(4, 4));
  const follower = createPictureFollower({ reduce: async () => undefined, watchFolder: () => undefined });
  follower.follow([folder, join(root, "hw-image-gone0001")]);
  await follower.settled();
  assert.deepEqual(helperRunPictures(folder), []);
});

test("each process sample follows the folders of the linked runs still alive", async () => {
  const followed: string[][] = [];
  const capture = createHelperRunCapture({
    readers: {
      directories: async () => new Map([[20, `/private${FOLDER}`], [30, "/var/folders/ab/c0ffee123/T/hw-image-lost0001"]]),
      parents: async () => new Map([[20, { agent: "claude" as const, sessionId: PARENT }]]),
    },
    remember: (links) => links.length,
    follow: (folders) => { followed.push([...folders]); },
  });
  await capture([{ pid: 20, command: "grok" }, { pid: 30, command: "grok" }]);
  await capture([{ pid: 20, command: "grok" }]);
  await capture([]);
  assert.deepEqual(followed, [[FOLDER], [FOLDER], []], "a run without a parent is not followed; an ended run stops");
  const failing = createHelperRunCapture({
    readers: { directories: async () => { throw new Error("lsof"); }, parents: async () => new Map() },
    follow: () => { throw new Error("watch"); },
  });
  assert.equal(await failing([{ pid: 40, command: "grok" }]), 0);
});

test("a run's pictures are shown on its card and take the place of the path in its answer", (t) => {
  configured(t);
  const first = png(5, 5), second = png(6, 6);
  for (const [bytes, name] of [[first, "image.png"], [second, "extra.png"]] as const) {
    keepHelperRunPicture(FOLDER, { hash: pictureHash(bytes), name, source: `${FOLDER}/${name}`,
      mime: "image/png", capturedAt: Date.now() }, bytes);
  }
  const parent: SessionInfo = { sessionId: PARENT, agent: "claude", state: "working", startedAt: 1,
    lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  const run: SessionInfo = { sessionId: "grok-run-0001", agent: "grok", state: "idle", startedAt: 1,
    lastActivityAt: 2, tokensSession: 5, tokensLastTurn: 5, title: "Use your image_gen tool" };
  const [shown] = attachHelperRuns([parent], [{ session: run, kind: "image-generation", label: "Image generation",
    folder: FOLDER }], linkTo(PARENT));
  const child = shown!.childThreads![0]! as ChildThreadInfo;
  assert.deepEqual(child.images!.map((image) => [image.id, image.name]), [
    [helperRunImageId(FOLDER, pictureHash(first)), "image.png"],
    [helperRunImageId(FOLDER, pictureHash(second)), "extra.png"]]);
  assert.equal(ChildThreadSchema.parse(child).images!.length, 2, "the protocol carries a card's pictures");

  const entries: ActivityEntry[] = [
    { id: "a", kind: "message", text: "I'll generate one image.", createdAt: 1 },
    { id: "b", kind: "final", text: `Saved:\n- \`/private${FOLDER}/image.png\``, createdAt: 2 },
    { id: "c", kind: "tool", text: "sips", createdAt: 3 },
  ];
  const read = helperRunEntries(child, entries, FOLDER);
  assert.equal(read[0]!.images, undefined);
  assert.equal(read[2]!.images, undefined);
  assert.deepEqual(read[1]!.images!.map((image) => image.markdown), [
    `\`/private${FOLDER}/image.png\``,
    `![extra.png](granttap-image:${helperRunImageId(FOLDER, pictureHash(second))})`]);
  assert.ok(read.every((entry) => entry.childThreadId === "grok-run-0001"));

  const noFinal = helperRunEntries(child, entries.filter((entry) => entry.kind !== "final"), FOLDER);
  assert.equal(noFinal[0]!.images!.length, 2, "without an answer the last message carries them");
  assert.equal(helperRunEntries(child, [entries[2]!], FOLDER)[0]!.images, undefined);
  assert.equal(helperRunEntries(child, entries)[1]!.images, undefined, "without a folder nothing is attached");
});

test("the phone's copy is a JPEG at most 1600 pixels long, never enlarged", { skip: process.platform !== "darwin" }, async () => {
  const large = png(2_000, 1_125, true);
  assert.ok(large.length > 400 * 1024);
  const reduced = await reducePicture(large, "image/png");
  assert.equal(reduced?.mime, "image/jpeg");
  assert.ok(reduced!.bytes.length < large.length);
  const work = mkdtempSync(join(tmpdir(), "granttap-reduced-"));
  try {
    writeFileSync(join(work, "r.jpg"), reduced!.bytes);
    const { execFileSync } = await import("node:child_process");
    const size = parseSipsSize(execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(work, "r.jpg")],
      { encoding: "utf8" }));
    assert.deepEqual(size, { width: 1_600, height: 900 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const small = png(10, 10);
  assert.equal((await reducePicture(small, "image/png"))?.bytes, small, "a small picture is kept as it is");
});

test("sizes are read from sips' answer, and a picture that cannot be converted is kept as it is when it fits", async () => {
  assert.deepEqual(parseSipsSize("/x.png\n  pixelWidth: 2752\n  pixelHeight: 1536\n"), { width: 2752, height: 1536 });
  assert.equal(parseSipsSize("nothing"), undefined);
  const broken = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(500 * 1024, 1)]);
  const kept = await reducePicture(broken, "image/png");
  assert.equal(kept?.bytes, broken);
  assert.equal(await reducePicture(Buffer.alloc(9 * 1024 * 1024, 1), "image/png"), undefined,
    "too large to keep as it is, and not a picture sips can read");
});
