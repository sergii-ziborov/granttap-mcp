import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDesktopAttachments } from "../attachments";

test("desktop batches reject malformed manifests, missing files and unsafe file access", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-message-"));
  const path = join(directory, "0");
  const file = { name: "file.bin", mimeType: "application/octet-stream", path };
  const read = (rows: unknown) => readDesktopAttachments(JSON.stringify(rows));
  try {
    assert.deepEqual(readDesktopAttachments(undefined), []);
    for (const value of [null, 42, "bad", " ".repeat(32_769)]) {
      assert.equal(readDesktopAttachments(value), undefined);
    }
    for (const rows of [null, {}, [], [null], Array(11).fill(file), [{ ...file, path: 1 }],
      [{ ...file, path: "/x/invalid" }], [{ ...file, path: "/" + "x".repeat(4096) }], [file]]) {
      assert.equal(read(rows), undefined);
    }
    writeFileSync(path, Buffer.from([0, 255, 1]), { mode: 0o600 });
    assert.equal(read([file])?.[0]?.data, "AP8B");
    assert.equal(read([file, file]), undefined);
    assert.equal(read([{ ...file, name: "" }]), undefined);
    chmodSync(directory, 0o755);
    assert.equal(read([file]), undefined);
    chmodSync(directory, 0o700);
    chmodSync(path, 0o644);
    assert.equal(read([file]), undefined);
    rmSync(path);
    symlinkSync("/etc/hosts", path);
    assert.equal(read([file]), undefined);
    rmSync(path);
    writeFileSync(path, Buffer.alloc(6_000_001), { mode: 0o600 });
    assert.equal(read([file]), undefined);
    writeFileSync(path, Buffer.alloc(6_000_000), { mode: 0o600 });
    const second = join(directory, "1");
    writeFileSync(second, Buffer.alloc(5_000_001), { mode: 0o600 });
    assert.equal(read([file, { ...file, path: second }]), undefined);
    assert.equal(read([{ ...file, path: join(tmpdir(), "0") }]), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
