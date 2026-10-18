import assert from "node:assert/strict";
import test from "node:test";
import { engineSocketEndpoint } from "../local-endpoint";

test("Windows clients share the Rust daemon's deterministic owner configuration endpoint", () => {
  const expected = "\\\\.\\pipe\\granttap-engine-7ff92716fa04ce0f081dbcde11e1b548dad6bcb44f03c856aa811161fce3e93f";
  assert.equal(engineSocketEndpoint("C:\\Users\\Alice\\.granttap\\engine.sock", "win32"), expected);
  assert.equal(engineSocketEndpoint("c:/users/alice/.granttap/./engine.sock", "win32"), expected);
  assert.equal(engineSocketEndpoint(expected, "win32"), expected);
  assert.notEqual(engineSocketEndpoint("C:\\Users\\Bob\\.granttap\\engine.sock", "win32"), expected);
});
test("local Engine endpoint selection never turns a remote share into an IPC address", () => {
  for (const path of ["relative.sock", "\\\\remote\\pipe\\granttap-engine-unsafe", "\\\\.\\pipe\\unrelated"]) {
    assert.throws(() => engineSocketEndpoint(path, "win32"), /local|absolute/i);
  }
  assert.equal(engineSocketEndpoint("/tmp/engine.sock", "darwin"), "/tmp/engine.sock");
  assert.equal(engineSocketEndpoint("/tmp/engine.sock", "linux"), "/tmp/engine.sock");
});
