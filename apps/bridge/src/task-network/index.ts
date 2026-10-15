import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectTransportSet, type TaskNetworkPeer } from '../../../../packages/protocol/task-network';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { writePrivateFile } from '../config/access/write-private';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const taskNetworkScope = (projectId: string, source: string, target: string, revision: number) =>
  hash(JSON.stringify(['granttap-task-network-v1', projectId, source, target, revision]));
type Saved = { configuration: ProjectTransportSet; controller: string };

/** Computer-enforced, controller-issued Project grants; peer keys never become controller keys. */
export class TaskNetworkStore {
  constructor(private readonly directory: string, readonly endpointId: string, readonly publicKey: string,
    private readonly allowNativeIssuer = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  configure(input: unknown, controller: string, projectAllowed: (projectId: string) => boolean,
    now = Date.now()): boolean {
    const parsed = ProjectTransportSet.safeParse(input);
    if (!parsed.success) return false;
    const configuration = parsed.data;
    if (controller.startsWith('native:') && !this.nativeIssuer(controller)) return false;
    if (configuration.targetEndpointId !== this.endpointId || !projectAllowed(configuration.projectId)
      || configuration.createdAt > now + 30_000 || configuration.expiresAt <= now
      || configuration.expiresAt > now + 30 * 86_400_000
      || configuration.peers.some(peer => peer.publicKey === this.publicKey
        || peer.outgoing.expiresAt > configuration.expiresAt || peer.outgoing.expiresAt <= now
        || peer.outgoing.scopeHash !== taskNetworkScope(configuration.projectId, this.endpointId,
          peer.endpointId, configuration.revision))) return false;
    const path = this.path(configuration.projectId);
    return withStoreLock(path, () => {
      const previous = this.read(configuration.projectId)?.configuration;
      if (previous && (previous.revision > configuration.revision
        || previous.revision === configuration.revision && previous.createdAt > configuration.createdAt)) return false;
      if (previous?.revision === configuration.revision && previous.createdAt === configuration.createdAt) {
        return JSON.stringify(previous) === JSON.stringify(configuration);
      }
      if (!previous && this.projectIds().length >= 128) return false;
      writePrivateFile(path, JSON.stringify({ configuration, controller }));
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== 'win32') {
        const parent = openSync(this.directory, 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
      return true;
    });
  }

  current(projectId: string, controllerAllowed: (publicKey: string) => boolean,
    now = Date.now()): ProjectTransportSet | undefined {
    const saved = this.read(projectId);
    return saved && saved.configuration.enabled && saved.configuration.expiresAt > now
      && (this.nativeIssuer(saved.controller) || controllerAllowed(saved.controller)) ? saved.configuration : undefined;
  }

  all(controllerAllowed: (publicKey: string) => boolean, now = Date.now()): ProjectTransportSet[] {
    return this.projectIds().flatMap(projectId => this.current(projectId, controllerAllowed, now) ?? []);
  }

  incoming(writerId: string, controllerAllowed: (publicKey: string) => boolean, now = Date.now()):
    { configuration: ProjectTransportSet; peer: TaskNetworkPeer } | undefined {
    const matches = this.all(controllerAllowed, now).flatMap(configuration => configuration.peers
      .filter(peer => peer.incomingWriterId === writerId).map(peer => ({ configuration, peer })));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private projectIds(): string[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .slice(0, 128).flatMap(name => {
        const value = this.readPath(join(this.directory, name));
        return value ? [value.configuration.projectId] : [];
      });
  }

  private read(projectId: string): Saved | undefined { return this.readPath(this.path(projectId)); }

  private nativeIssuer(issuer: string): boolean {
    return this.allowNativeIssuer && issuer === `native:${this.publicKey}`;
  }

  private readPath(path: string): Saved | undefined {
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > 256_000) throw new Error('Project transport configuration exceeds its bound.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const configuration = ProjectTransportSet.parse(raw.configuration);
    if (typeof raw.controller !== 'string' || configuration.targetEndpointId !== this.endpointId) return undefined;
    return { configuration, controller: raw.controller };
  }

  private path(projectId: string): string { return join(this.directory, `${hash(projectId)}.json`); }
}
