import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RelayClient, sealEnvelope } from "../../relay-client";
import { generateKeyPair, open } from "../../crypto";
import type { Payload } from "../../../protocol/schema";
import { ActiveControllerRecipients } from "..";

test("replaceable updates target active authenticated controllers without revoking sleeping ones", async t => {
  const server=new WebSocketServer({port:0});await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const machine=generateKeyPair(),a=generateKeyPair(),b=generateKeyPair();
  const cfg={relayUrl:`ws://127.0.0.1:${address.port}`,room:"fixture",role:"machine" as const,
    deviceName:"Fixture",senderId:"machine",myPublicKey:machine.publicKey,mySecretKey:machine.secretKey,
    peerPublicKey:a.publicKey,extraPeerPublicKeys:[b.publicKey]};
  let socket!:import("ws").WebSocket;
  const frames:any[]=[];
  server.on("connection",s=>{socket=s;s.on("message",raw=>{frames.push(JSON.parse(raw.toString()));});});
  const client=new RelayClient(cfg);
  t.after(async()=>{client.close();for(const s of server.clients)s.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await client.connect();
  const greeted=client.waitFor((p): p is Extract<Payload,{type:"hello"}>=>p.type==="hello"&&p.role==="phone",1000);
  socket.send(sealEnvelope({...cfg,role:"phone",senderId:"phone",mySecretKey:a.secretKey,
    peerPublicKey:machine.publicKey},{type:"hello",role:"phone",deviceName:"Fixture",createdAt:Date.now()},"machine"));
  await greeted;
  frames.length=0;
  await client.send({type:"machine.heartbeat",machine:"Fixture",createdAt:Date.now()},"phone",{reliable:false});
  await new Promise<void>(resolve=>setTimeout(resolve,30));
  const heartbeat=frames.filter(e=>(open(e.nonce,e.box,a.publicKey,machine.secretKey) as any)?.type==="machine.heartbeat"
    || (open(e.nonce,e.box,b.publicKey,machine.secretKey) as any)?.type==="machine.heartbeat");
  assert.equal(heartbeat.length,1,"Sleeping controllers must not multiply every replaceable frame.");
  assert.deepEqual(cfg.extraPeerPublicKeys,[b.publicKey],"Presence must not remove a pairing.");
  frames.length=0;
  await client.send({type:"machine.heartbeat",machine:"Fixture",createdAt:Date.now()},"phone",{reliable:true});
  await new Promise<void>(resolve=>setTimeout(resolve,30));
  assert.equal(frames.length,2,"Reliable delivery must retain every authorized recipient.");
});

test("legacy and returning controllers remain reachable after activity expires", () => {
  const recipients = new ActiveControllerRecipients();
  assert.equal(recipients.allows("sleeping", true, 1000), true);
  recipients.observe("active", 1000);
  assert.equal(recipients.allows("active", true, 1001), true);
  assert.equal(recipients.allows("sleeping", true, 1001), false);
  assert.equal(recipients.allows("sleeping", false, 1001), true);
  assert.equal(recipients.allows("sleeping", true, 91001), true);
});
