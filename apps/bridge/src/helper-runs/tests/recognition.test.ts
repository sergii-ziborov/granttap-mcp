import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChildThreadInfo } from "../../../../../packages/protocol/schema";
import { helperRunFolder, helperRunLabel, helperRunProject } from "../kinds";

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
