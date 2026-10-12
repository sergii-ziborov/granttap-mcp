import assert from "node:assert/strict";
import test from "node:test";
import {projectRepositoryGraphs} from "../../../apps/bridge/src/engine/runtime/engine-projects";
import type {EngineClientLike} from "../../../apps/bridge/src/engine/runtime/engine-supervisor";

test("multiple repository reports leave room for Mesh metadata and retain every repository",async()=>{
    const files=Array.from({length:1_000},(_,index)=>({path:`Sources/File-${index}.swift`,language:"swift",
        line_count:100,symbols:Array.from({length:6},(_,symbol)=>({id:`symbol-${index}-${symbol}`,
            label:"Fixture symbol ".repeat(8),kind:"function",start_line:symbol+1,line_count:10}))}));
    const client:EngineClientLike={close(){},async request(input){
        if(input.operation!=="graph.analyze_repository")throw Error("Unexpected fixture operation");
        return {operation:"graph.repository",graph:{project_id:input.input.project_id,
            repository_id:input.input.repository_id,revision:"content",weavatrix_version:"2.17.4",
            analysis_status:"COMPLETE",nodes:[],relations:[],total_nodes:0,total_relations:0,truncated:false,
            code_map:{files,roads:[],total_files:1_000,truncated:false}}};
    }};
    const bindings=["first","second"].map(id=>({projectId:"wire-budget",bindingId:id,endpointId:"mac",
        repositoryId:id,displayName:id,available:true,revision:"head"}));
    const graphs=await projectRepositoryGraphs("wire-budget",bindings,{client,env:{GRANTTAP_ENGINE_ENABLED:"1"}});
    assert.equal(graphs.length,2,"A large first repository cannot hide the next repository");
    assert.ok(Buffer.byteLength(JSON.stringify(graphs))<=192*1_024,
        "Mesh metadata and its analysis receipt also need space in the 256KiB envelope");
    assert.ok(graphs.every(graph=>graph.codeMap?.truncated===true));
});
