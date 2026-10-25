import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RelayClient, sealEnvelope } from "../../relay-client";
import { generateKeyPair, generateTransferKey, open } from "../../crypto";
import type { Payload } from "../../../protocol/schema";
import { sendSessionPayload } from "../../../../apps/bridge/src/host/session-keys";

test("catalog and chat content reach every authorized controller", async t => {
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
  assert.equal(heartbeat.length,2,"Passive controllers still need metadata to discover changes.");
  assert.deepEqual(cfg.extraPeerPublicKeys,[b.publicKey],"Presence must not remove a pairing.");
  frames.length=0;
  client.setSessionKey("fixture-task",generateTransferKey());
  await client.sendSession({type:"session.activity",sessionId:"fixture-task",agent:"claude",
    state:"idle",entries:[],generatedAt:Date.now()},"fixture-task","phone",{reliable:false});
  await new Promise<void>(resolve=>setTimeout(resolve,30));
  assert.equal(frames.length,2,"A controller receiving passively must retain its chat replica.");
  frames.length=0;
  await client.send({type:"machine.heartbeat",machine:"Fixture",createdAt:Date.now()},"phone",{reliable:true});
  await new Promise<void>(resolve=>setTimeout(resolve,30));
  assert.equal(frames.length,2,"Reliable delivery must retain every authorized recipient.");
});

test("a requested transcript grants and delivers only to its authenticated requester", async t => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const machine = generateKeyPair(), first = generateKeyPair(), requester = generateKeyPair();
  const cfg = { relayUrl: `ws://127.0.0.1:${address.port}`, room: "requested-replica",
    role: "machine" as const, deviceName: "Fixture", senderId: "machine",
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey,
    peerPublicKey: first.publicKey, extraPeerPublicKeys: [requester.publicKey] };
  const frames: any[] = [];
  server.on("connection", socket => socket.on("message", raw => frames.push(JSON.parse(raw.toString()))));
  const client = new RelayClient(cfg);
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await client.connect();
  await receivedFrames(frames, 2);
  frames.length = 0;
  await sendSessionPayload(client, { type: "session.activity", sessionId: "replica-wire-fixture",
    agent: "claude", state: "idle", entries: [], generatedAt: Date.now(),
    history: { hasMore: false } }, "replica-wire-fixture", "phone",
    { reliable: false, peerPublicKey: requester.publicKey });
  await receivedFrames(frames, 2);
  assert.equal(frames.length, 2, "One grant and one transcript belong to this read request.");
  assert.equal(frames.some(e => open(e.nonce, e.box, first.publicKey, machine.secretKey)), false);
  assert.deepEqual(frames.map(e => (open(e.nonce, e.box, requester.publicKey,
    machine.secretKey) as any)?.type), ["session.key.grant", "session.sealed"]);
  await assert.rejects(client.send({ type: "machine.heartbeat", machine: "Fixture", createdAt: Date.now() },
    "phone", { peerPublicKey: generateKeyPair().publicKey }), /not authorized/);
});

async function receivedFrames(frames: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (frames.length < count && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assert.equal(frames.length, count, "The local receiver must observe every expected frame before the next phase.");
}

test('a controller receipt overtakes queued transcript snapshots for the same phone', async t => {
  const server = new WebSocketServer({ port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const machine = generateKeyPair(), phone = generateKeyPair();
  const cfg = { relayUrl: `ws://127.0.0.1:${address.port}`, room: 'receipt-priority',
    role: 'machine' as const, deviceName: 'Fixture', senderId: 'machine',
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey };
  const frames: any[] = [];
  server.on('connection', socket => socket.on('message', raw => frames.push(JSON.parse(raw.toString()))));
  const client = new RelayClient(cfg);
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect(); await receivedFrames(frames, 1); frames.length = 0;
  const snapshots = Array.from({ length: 16 }, (_, n) => client.send({ type: 'session.activity',
    sessionId: `fixture-${n}`, agent: 'grok', state: 'idle', entries: [], generatedAt: Date.now() },
  'phone', { peerPublicKey: phone.publicKey, reliable: false }));
  const receipt = client.send({ type: 'delivery.receipt', messageId: 'original-message',
    status: 'accepted', receivedAt: Date.now() }, 'phone', { peerPublicKey: phone.publicKey });
  await Promise.all([...snapshots, receipt]); await receivedFrames(frames, 17);
  const types = frames.map(frame => (open(frame.nonce, frame.box, phone.publicKey, machine.secretKey) as any)?.type);
  assert.ok(types.indexOf('delivery.receipt') <= 1, 'Receipt cannot wait behind a history download');
  assert.equal(types.filter(type => type === 'session.activity').length, 16);
});
