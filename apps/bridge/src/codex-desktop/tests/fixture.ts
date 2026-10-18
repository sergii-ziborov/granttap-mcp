import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export type Request = { type: string; requestId: string; method: string;
  params: any; version: number; targetClientId?: string; sourceClientId?: string };
export type Owner = (request: Request, socket: Socket) => unknown;

export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

export function respond(socket: Socket, request: Request, result: unknown): void {
  socket.write(frame({ type: 'response', requestId: request.requestId, method: request.method,
    resultType: 'success', handledByClientId: 'native-owner', result }));
}

export function refuse(socket: Socket, request: Request, error: string): void {
  socket.write(frame({ type: 'response', requestId: request.requestId, method: request.method,
    resultType: 'error', error }));
}

export async function fixture(t: TestContext, owner?: Owner, options: { ownerFound?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'granttap-native-'));
  const home = join(root, 'codex');
  await mkdir(join(home, 'ipc'), { recursive: true, mode: 0o700 });
  const path = join(home, 'ipc', 'ipc.sock');
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE() + 4) {
        const size = buffered.readUInt32LE();
        const request = JSON.parse(buffered.subarray(4, size + 4).toString()) as Request;
        buffered = buffered.subarray(size + 4);
        requests.push(request);
        if (request.method === 'initialize') respond(socket, request, { clientId: randomUUID() });
        else if (request.method === 'thread-owner-discovery') {
          if (options.ownerFound === false) refuse(socket, request, 'no-client-found');
          else respond(socket, request, { supportsUntrustedAppInput: true });
        }
        else if (owner) owner(request, socket);
        else respond(socket, request, { result: { turn: { id: 'native-turn', status: 'inProgress' } } });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  const bin = join(root, 'codex.mjs');
  const marker = join(root, 'headless-used');
  await writeFile(bin, '#!/usr/bin/env node\n' +
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'started');\n` +
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'headless'}}));\n", { mode: 0o755 });
  for (const [key, value] of Object.entries({ GRANTTAP_CODEX_DIR: home, GRANTTAP_CODEX_BIN: bin,
    GRANTTAP_CONFIG_DIR: join(root, 'config') })) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => prior === undefined ? delete process.env[key] : process.env[key] = prior);
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const session = { agent: 'codex' as const, sessionId: randomUUID(), cwd: root, state: 'working' as const,
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0 };
  return { root, home, path, marker, requests, session, server };
}
