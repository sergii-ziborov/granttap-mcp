import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EngineClient } from "../../engine-client";
import { EngineFrameDecoder, encodeEngineFrame } from "../../../protocol/engine-protocol";

test("Engine client correlates Project relationship responses on the real framed channel", async () => {
  const root = await mkdtemp("/tmp/granttap-links-wire-");
  const path = join(root, "engine.sock");
  const server = createServer(socket => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", chunk => {
      for (const input of decoder.push(chunk)) {
        assert.equal(input.operation, "graph.analyze_project");
        socket.write(encodeEngineFrame({protocol_version:1, request_id:input.request_id, status:"ok",
          result:{operation:"graph.project_relationships",graph:{
            project_id:"project",weavatrix_version:"2.17.5",analysis_status:"COMPLETE",
            repositories:[{repository_id:"api",revision:"a"},{repository_id:"client",revision:"b"}],
            matches:[],truncated:false,
          }},
        }));
      }
    });
  });
  const client = new EngineClient({socketPath:path});
  try {
    await new Promise<void>(resolve => server.listen(path, resolve));
    const result = await client.request({operation:"graph.analyze_project",input:{
      project_id:"project",repository_ids:["api","client"],
    }});
    assert.equal(result.operation,"graph.project_relationships");
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
