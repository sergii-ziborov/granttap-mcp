import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
test("concurrent MCP processes retain every task key and agree on one shared conversation key", async (t) => {
    const directory = mkdtempSync("/tmp/granttap-concurrent-keys-");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const module = fileURLToPath(new URL("../../session-keys.ts", import.meta.url));
    const workers = [0, 1].map(index => {
        const source = `import{sessionKey}from${JSON.stringify(module)};
import{writeFileSync,existsSync}from'node:fs';import{createHash}from'node:crypto';
writeFileSync(${JSON.stringify(join(directory, 'ready-' + index))},'ready');
while(!existsSync(${JSON.stringify(join(directory, 'go'))}))await new Promise(r=>setTimeout(r,5));
const key=sessionKey('shared-conversation');
for(let i=0;i<150;i++)sessionKey('worker-${index}-'+i);
process.stdout.write(createHash('sha256').update(key).digest('hex'));`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, GRANTTAP_CONFIG_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
        let output = "", error = "";
        child.stdout.on("data", chunk => output += chunk);
        child.stderr.on("data", chunk => error += chunk);
        t.after(() => { if (child.exitCode === null)
            child.kill(); });
        return new Promise<string>((resolve, reject) => {
            child.on("error", reject);
            child.on("exit", code => code === 0 ? resolve(output) : reject(Error(error)));
        });
    });
    const deadline = Date.now() + 30000;
    while (![0, 1].every(index => existsSync(join(directory, 'ready-' + index)))) {
        if (Date.now() > deadline)
            throw Error("Key fixture processes did not become ready");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(join(directory, "go"), "go");
    const hashes = await Promise.all(workers);
    const stored = JSON.parse(readFileSync(join(directory, "session-keys.json"), "utf8"));
    assert.equal(Object.keys(stored).length, 301, "Concurrent task creation must not erase other task keys");
    assert.equal(hashes[0], hashes[1], "One conversation must have the same key in every MCP process");
});
