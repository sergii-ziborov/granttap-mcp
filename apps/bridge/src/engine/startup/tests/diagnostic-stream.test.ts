import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { keepDiagnosticsNonFatal } from "../diagnostic-stream";

test("a stderr write the disk refuses no longer ends the process", () => {
  const stderr = new PassThrough();
  const full = Object.assign(new Error("no space left on device, write"), { code: "ENOSPC" });
  assert.throws(() => stderr.emit("error", full), /no space left/, "an unheard stream error is fatal");
  keepDiagnosticsNonFatal(stderr);
  assert.doesNotThrow(() => stderr.emit("error", full));
});
