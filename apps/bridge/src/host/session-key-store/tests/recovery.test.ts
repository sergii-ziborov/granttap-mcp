import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { persistedSessionKey } from "..";
function fixture(t: test.TestContext) {
    const directory = mkdtempSync("/tmp/granttap-key-recovery-");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "session-keys.json");
}
test("malformed private key storage is preserved instead of replaced with an empty dictionary", t => {
    const path = fixture(t);
    writeFileSync(path, "broken private dictionary");
    assert.throws(() => persistedSessionKey(path, "new-task"), /unreadable/);
    assert.equal(readFileSync(path, "utf8"), "broken private dictionary");
    writeFileSync(path, "[]");
    assert.throws(() => persistedSessionKey(path, "new-task"), /unreadable/);
});
test("dead owners and abandoned empty directories recover while active owners remain protected", t => {
    const path = fixture(t), lock = path + ".lock";
    const original = persistedSessionKey(path, "original");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    mkdirSync(lock);
    writeFileSync(join(lock, "owner-2147483647-dead"), "");
    const recovered = persistedSessionKey(path, "after-crash");
    assert.equal(typeof recovered, "string");
    assert.equal(existsSync(lock), false);
    assert.equal(persistedSessionKey(path, "original"), original);
    mkdirSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    persistedSessionKey(path, "after-empty-crash");
    mkdirSync(lock);
    writeFileSync(join(lock, `owner-${process.pid}-active`), "");
    assert.equal(persistedSessionKey(path, "original"), original);
    assert.throws(() => persistedSessionKey(path, "busy-new-task", 20), /busy/);
    assert.ok(existsSync(join(lock, `owner-${process.pid}-active`)));
});
