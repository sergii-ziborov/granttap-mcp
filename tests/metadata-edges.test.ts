import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpDescriptor } from "../apps/bridge/src/capabilities/types";
import {
  cachedMetadata,
  refreshDescriptorMetadata,
} from "../apps/bridge/src/capabilities/metadata";

test("metadata probing caches failures and normalizes only bounded safe icons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-metadata-edges-"));
  const server = join(root, "server.mjs");
  await writeFile(server, [
    "let pending=''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { pending += chunk; for (;;) {",
    " const at=pending.indexOf('\\n'); if(at<0) break; const line=pending.slice(0,at); pending=pending.slice(at+1); if(!line) continue;",
    " const request=JSON.parse(line); if(request.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{",
    " protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'edges',title:'  ',version:'  ',websiteUrl:'http://unsafe.test',icons:[",
    " {src:'data:image/svg+xml;base64,AAA=',mimeType:'image/svg+xml'},",
    " {src:'data:image/png;base64,bm90LWltYWdl',mimeType:'image/png'},",
    " {src:'https://other.test/icon.png',mimeType:'image/png'},",
    " {src:'data:image/jpeg;base64,/9j/AA==',mimeType:'image/jpeg',sizes:['1x1'],theme:'dark'},",
    " ]}}})+'\\n');",
    "}});",
  ].join("\n"), { mode: 0o755 });
  const previous = process.env.GRANTTAP_METADATA_TOKEN;
  process.env.GRANTTAP_METADATA_TOKEN = "token";
  t.after(() => previous == null
    ? delete process.env.GRANTTAP_METADATA_TOKEN
    : process.env.GRANTTAP_METADATA_TOKEN = previous);
  const descriptor: McpDescriptor = {
    name: "metadata-edges", configuredEnabled: true,
    transport: {
      type: "stdio", command: process.execPath,
      args: [server, 3], env: { STATIC: "yes", ignored: 4 },
      env_vars: ["GRANTTAP_METADATA_TOKEN", 3], cwd: root,
    },
  };
  await Promise.all([refreshDescriptorMetadata(descriptor), refreshDescriptorMetadata(descriptor)]);
  const metadata = cachedMetadata(descriptor);
  assert.equal(metadata?.title, undefined);
  assert.equal(metadata?.version, undefined);
  assert.equal(metadata?.websiteUrl, undefined);
  assert.deepEqual(metadata?.icons, [{
    src: "data:image/jpeg;base64,/9j/AA==", mimeType: "image/jpeg",
    sizes: ["1x1"], theme: "dark",
  }]);
  await refreshDescriptorMetadata(descriptor);

  for (const invalid of [
    { name: "disabled", configuredEnabled: false },
    { name: "missing-transport", configuredEnabled: true },
    { name: "unsafe-http", configuredEnabled: true, transport: { type: "http", url: "http://localhost" } },
    { name: "credentials", configuredEnabled: true, transport: { type: "sse", url: "https://user:pass@example.test" } },
    { name: "unsupported", configuredEnabled: true, transport: { type: "stdio" } },
  ] satisfies McpDescriptor[]) {
    await refreshDescriptorMetadata(invalid);
    assert.equal(cachedMetadata(invalid), undefined);
  }
});
