import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRepositoryGraphs, projectBackbone, closeProjectEngineClient } from '../../../apps/bridge/src/engine/runtime/engine-projects';
import { EngineFrameDecoder, encodeEngineFrame, type EngineRequest } from '../../../apps/bridge/src/engine/protocol/engine-protocol';

test('repository analysis cannot delay the control channel on a serial Engine connection', async t => {
  const root=mkdtempSync(join(tmpdir(),'granttap-analysis-channel-'));
  const previous=process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR=root;
  closeProjectEngineClient();
  const sockets = new Set<Socket>();
  let release!:()=>void, started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const analyzing=new Promise<void>(resolve=>{started=resolve;});
  const server=createServer(socket=>{
    sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));
    const decoder=new EngineFrameDecoder();
    let chain=Promise.resolve();
    socket.on('data',chunk=>{
      for(const request of decoder.push(chunk) as EngineRequest[]) {
        chain=chain.then(async()=>{
          let result;
          if(request.operation==='graph.analyze_repository') {
            started(); await held;
            result={operation:'graph.repository',graph:{project_id:'project',repository_id:'repo',
              revision:'sha',weavatrix_version:'2.17.4',analysis_status:'COMPLETE',nodes:[],relations:[],
              total_nodes:0,total_relations:0,truncated:false}};
          } else {
            result={operation:'graph.backbone',backbone:{project_id:'project',head:null,nodes:[],relations:[],pending_candidate_count:0}};
          }
          if(!socket.destroyed) socket.write(encodeEngineFrame({protocol_version:1,request_id:request.request_id,status:'ok',result}));
        });
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(join(root,'engine.sock'),resolve));
  t.after(async()=>{
    release(); closeProjectEngineClient(); for(const socket of sockets) socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous==null) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR=previous;
    rmSync(root,{recursive:true,force:true});
  });
  const env={GRANTTAP_ENGINE_ENABLED:'1'};
  const graphs=projectRepositoryGraphs('project',[{projectId:'project',bindingId:'binding',endpointId:'computer',
    repositoryId:'repo',displayName:'Repository',available:true}],{env});
  await analyzing;
  try {
    const control=await projectBackbone('project',{env});
    assert.equal(control?.projectId,'project','control results must arrive while repository work is held');
  } finally { release(); await graphs; }
});
