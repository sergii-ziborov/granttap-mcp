import assert from "node:assert/strict";
import test from "node:test";
import { windowsDesktopPipePath } from "../../engine-bridge";

test("desktop bridge uses a Windows named pipe for private local IPC", () => {
  const path = windowsDesktopPipePath("123e4567-e89b-42d3-a456-426614174000");
  assert.equal(path, String.raw`\\.\pipe\granttap-desktop-123e4567-e89b-42d3-a456-426614174000`);
});
