import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServerInfo, ProjectMcpServer, type SessionInfo } from "../../../../../packages/protocol/schema";
import { projectMcpServers } from "../../mesh/catalog/project/capabilities";
import { mergeConfiguredMcpServers } from "../../mesh/catalog/project/configured-mcp";
import { cachedMetadata, refreshDescriptorMetadata } from "../metadata";

test("initialize descriptions are trimmed, bounded and absent when blank", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-description-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "server.mjs");
  await writeFile(script, `let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;let at;
while((at=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
if(request.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,
result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'review',version:'1',description:process.argv[2]}}})+'\\n');}});`);
  for (const [description, expected] of [[" x ", "x"], [" ", undefined], ["y".repeat(4_100), "y".repeat(4_000)]]) {
    const descriptor = { name: `description-${description?.length}`, configuredEnabled: true,
      transport: { command: process.execPath, args: [script, description] } };
    await refreshDescriptorMetadata(descriptor);
    assert.equal(cachedMetadata(descriptor)?.description, expected);
  }
});

test("session and Project catalogs preserve actual metadata without granting access", () => {
  const server = McpServerInfo.parse({ name: "review", configuredEnabled: true, allowed: false,
    title: "Review", description: "Inspect changes", websiteUrl: "https://example.test", metadataSource: "mcp",
    icons: [{ src: "data:image/png;base64,iVBORw0KGgo=" }] });
  const session: SessionInfo = { sessionId: "chat", agent: "codex", projectId: "project", computerId: "mac",
    state: "idle", startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0, mcpServers: [server] };
  const row = ProjectMcpServer.parse(projectMcpServers([session], "project")[0]);
  assert.equal(row.description, server.description);
  assert.deepEqual(row.icons, server.icons);
  assert.equal(row.allowed, false);
  assert.equal(mergeConfiguredMcpServers([row], [{ ...row, description: undefined, icons: undefined }])[0]?.description,
    server.description);
  const conflict = mergeConfiguredMcpServers([{ ...row, version: "1" }], [{ ...row, version: "2" }])[0];
  assert.equal(conflict?.authStatus, "conflict");
  assert.equal(conflict?.description, undefined);
  assert.equal(conflict?.icons, undefined);
  assert.equal(McpServerInfo.safeParse({ ...server, description: "x".repeat(4_001) }).success, false);
  assert.equal(ProjectMcpServer.safeParse({ ...row, description: "x".repeat(4_001) }).success, false);
});
