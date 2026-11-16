import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChildThreadInfo } from "../../../../../packages/protocol/schema";
import {
  FRESH_FOLDER_MS, forgetRunFolderChecks, freshRunFolder, helperRunFolder, helperRunLabel, helperRunProject,
  leftoverRunFolder, vanishedRunFolder,
} from "../kinds";
import { recognizeHelperRun } from "../recognition";

const MAC_TEMP = "/var/folders/ab/c0ffee123/T";

test("a generator's throwaway folder in the system temp directory is an image generation run", () => {
  for (const folder of [
    `${MAC_TEMP}/hw-image-1xnbh8ld`,
    `/private${MAC_TEMP}/hw-image-1xnbh8ld/`,
    "/tmp/hw-image-h3ospkyk",
    "/private/tmp/hw-image-h3ospkyk",
    join(tmpdir(), "hw-image-kfzumicu"),
    join(realpathSync(tmpdir()), "hw-image-kfzumicu"),
  ]) {
    assert.equal(helperRunFolder(folder)?.kind, "image-generation", folder);
  }
  assert.equal(helperRunLabel("image-generation"), "Image generation");
  assert.equal(helperRunLabel("something-newer"), "Helper run");
});

test("the two spellings of one temp folder are one folder", () => {
  assert.equal(helperRunFolder(`/private${MAC_TEMP}/hw-image-1xnbh8ld/`)?.folder,
    helperRunFolder(`${MAC_TEMP}/hw-image-1xnbh8ld`)?.folder);
  assert.equal(helperRunFolder("/private/tmp/hw-image-h3ospkyk")?.folder, "/tmp/hw-image-h3ospkyk");
});

test("a temp folder alone, or the prefix alone, is not a helper run", () => {
  for (const folder of [
    undefined,
    "",
    `${MAC_TEMP}/granttap-test-abc123`,
    `${MAC_TEMP}/hw-client-abc123`,
    `${MAC_TEMP}/hw-image-`,
    `${MAC_TEMP}/hw-image-1xnbh8ld/nested`,
    `${MAC_TEMP}/nested/hw-image-1xnbh8ld`,
    "/Users/someone/dev/hw-image-1xnbh8ld",
    "/Users/someone/dev/project/build/imagegen/hw-image-1xnbh8ld",
    "/var/folders/hw-image-1xnbh8ld",
    "hw-image-1xnbh8ld",
  ]) {
    assert.equal(helperRunFolder(folder), undefined, String(folder));
  }
});

test("a temp root named by the caller is honoured, for a computer whose temp directory is elsewhere", () => {
  assert.equal(helperRunFolder("/data/scratch/hw-image-abcd1234"), undefined);
  assert.equal(helperRunFolder("/data/scratch/hw-image-abcd1234", ["/data/scratch/"])?.kind, "image-generation");
  const windows = "C:\\Users\\someone\\AppData\\Local\\Temp";
  assert.equal(helperRunFolder(`${windows}\\hw-image-abcd1234`, [windows])?.folder,
    "C:/Users/someone/AppData/Local/Temp/hw-image-abcd1234");
  assert.equal(helperRunFolder(`${windows}\\other-abcd1234`, [windows]), undefined);
});

test("a Mesh that was registered for a helper run's folder is recognised by its workspace", () => {
  const folder = `/private${MAC_TEMP}/hw-image-1xnbh8ld`;
  assert.equal(helperRunProject({ repositoryRoot: folder, canonicalRepositoryId: `local:${folder}` }), true);
  assert.equal(helperRunProject({ canonicalRepositoryId: `local:${folder}` }), true);
  assert.equal(helperRunProject({ repositoryRoot: folder, canonicalRepositoryId: "github.com/acme/hw-image-1xnbh8ld" }), false,
    "a repository with a remote is a real Project wherever it was cloned");
  assert.equal(helperRunProject({ repositoryRoot: "/Users/someone/dev/app", canonicalRepositoryId: "local:/Users/someone/dev/app" }), false);
});

test("a nested conversation carries its helper kind, and one without it still parses", () => {
  const child = { threadId: "helper", parentThreadId: "chat", depth: 1, state: "idle" as const,
    startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 };
  assert.equal(ChildThreadInfo.parse({ ...child, kind: "image-generation" }).kind, "image-generation");
  assert.equal(ChildThreadInfo.parse(child).kind, undefined);
  assert.equal(ChildThreadInfo.parse({ ...child, kind: "a-kind-from-a-newer-computer" }).kind, "a-kind-from-a-newer-computer");
});

test("a folder made for one run is known by what became of it, not by its name", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-run-folders-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  forgetRunFolderChecks();
  const checkout = join(root, "app");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "docs"));
  mkdirSync(join(root, "plain", "kept"), { recursive: true });
  const now = Date.now();

  assert.equal(vanishedRunFolder(join(checkout, "build", "imagegen", "job.i1wr32"), now), true, "gone from inside a checkout");
  assert.equal(vanishedRunFolder(join(tmpdir(), "run-that-was-removed-0002"), now), true, "gone from the temp directory");
  assert.equal(vanishedRunFolder(join(checkout, "docs"), now), false, "a folder that is there");
  assert.equal(vanishedRunFolder(join(root, "plain", "removed"), now), false, "gone, but it was nobody's subfolder");
  assert.equal(vanishedRunFolder("build/imagegen/job.i1wr32", now), false);
  assert.equal(vanishedRunFolder(undefined, now), false);

  const later = join(checkout, "build", "later");
  assert.equal(vanishedRunFolder(later, now), true);
  mkdirSync(later, { recursive: true });
  assert.equal(vanishedRunFolder(later, now + 30_000), true, "the answer is kept for a minute");
  assert.equal(vanishedRunFolder(later, now + 61_000), false);

  const made = join(checkout, "build", "job.fresh1");
  mkdirSync(made, { recursive: true });
  // Not every disk records when a folder was made; where it does not, no folder is called new.
  if (statSync(made).birthtimeMs > 0) assert.equal(freshRunFolder(made, Date.now()), true, "made a moment ago");
  assert.equal(freshRunFolder(made, Date.now() + FRESH_FOLDER_MS + 60_000), false, "made too long ago to be this run's");
  assert.equal(freshRunFolder(checkout, Date.now()), false, "a checkout of its own");
  assert.equal(freshRunFolder(join(checkout, "missing"), Date.now()), false);
  assert.equal(freshRunFolder(tmpdir(), Date.now()), false, "the temp directory itself");
  assert.equal(freshRunFolder(undefined), false);

  const gone = join(checkout, "build", "imagegen", "job.i1wr32");
  assert.equal(helperRunProject({ repositoryRoot: gone, canonicalRepositoryId: `local:${gone}` }), true);
  assert.equal(helperRunProject({ repositoryRoot: gone, canonicalRepositoryId: "github.com/acme/app" }), false);
  assert.equal(helperRunProject({ canonicalRepositoryId: `local:${join(checkout, "docs")}` }), true,
    "a chat in a folder of a checkout belongs to the checkout's Mesh, so a Mesh of the folder's own is left over");
  assert.equal(helperRunProject({ canonicalRepositoryId: `local:${checkout}` }), false, "the checkout itself is kept");
});

test("a headless session is a run when its folder was made for a single request", () => {
  const folder = "/Users/someone/dev/app/build/imagegen/job.i1wr32";
  const session = { cwd: `${folder}/`, startedAt: 1_000, requests: 1, checkoutRoot: "/Users/someone/dev/app/" };
  const none = { link: () => undefined, vanished: () => false, fresh: () => false, now: 10_000 };
  const linked = { ...none, link: () => ({ folder, kind: "helper-run", parentAgent: "claude" as const,
    parentSessionId: "parent-chat-1", capturedAt: 1_500 }) };

  assert.equal(recognizeHelperRun(session, none), undefined, "a workspace that stays is a chat's");
  assert.deepEqual(recognizeHelperRun(session, { ...none, vanished: () => true }),
    { kind: "helper-run", label: "Helper run", folder });
  assert.deepEqual(recognizeHelperRun({ ...session, madePictures: true }, { ...none, fresh: () => true }),
    { kind: "image-generation", label: "Image generation", folder }, "a run that made a picture is called by it");
  assert.equal(recognizeHelperRun({ ...session, requests: 2 }, { ...none, vanished: () => true }), undefined,
    "a second request made it a chat");
  assert.equal(recognizeHelperRun({ ...session, checkoutRoot: folder }, { ...none, vanished: () => true }), undefined,
    "a checkout of its own, such as a removed worktree, was a workspace");
  assert.equal(recognizeHelperRun({ ...session, requests: 2 }, linked)?.kind, "helper-run",
    "the run that was alive when its folder was linked is a run whatever came after");
  assert.equal(recognizeHelperRun({ ...session, requests: 2, startedAt: 1_500 + 61_000 }, linked), undefined,
    "a later session in a folder of the same name is not that run");
  assert.equal(recognizeHelperRun({ startedAt: 1_000, requests: 1 }, { ...none, vanished: () => true }), undefined);
  assert.equal(recognizeHelperRun({ ...session, cwd: "/tmp/hw-image-h3ospkyk" }, none)?.kind, "image-generation",
    "a generator's folder says so by its name");
});

test("a folder inside a checkout that is still there is a leftover Mesh's, but never makes a chat a run", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-leftover-folders-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  forgetRunFolderChecks();
  const checkout = join(root, "app");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "build", "imagegen", "job.8fSByF"), { recursive: true });
  mkdirSync(join(checkout, "vendor", "lib", ".git"), { recursive: true });
  mkdirSync(join(root, "notes"));
  const job = join(checkout, "build", "imagegen", "job.8fSByF");

  assert.equal(leftoverRunFolder(job), true, "a folder of a checkout, still on disk");
  assert.equal(leftoverRunFolder(join(checkout, "build", "imagegen", "job.removed")), true, "and one that is gone");
  assert.equal(leftoverRunFolder(join(checkout, "vendor", "lib")), false, "a checkout of its own inside another");
  assert.equal(leftoverRunFolder(checkout), false, "the checkout itself");
  assert.equal(leftoverRunFolder(join(root, "notes")), false, "a workspace outside every checkout");
  assert.equal(helperRunProject({ repositoryRoot: job, canonicalRepositoryId: `local:${job}` }), true);
  assert.equal(vanishedRunFolder(job), false, "a chat in a folder that is there is not taken for a run");
});
