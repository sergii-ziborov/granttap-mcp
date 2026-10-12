import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectRepositoryGraph } from '../../../../../../packages/protocol/schema';
import { fitRepositoryGraph } from './fit';
/** Private computer-side observations; no hand-authored architecture enters this cache. */
export class RepositoryGraphCache {
    constructor(private readonly directory: string | (() => string), private readonly now: () => number = Date.now) { }
    read(key: string): {
        value: ProjectRepositoryGraph;
        savedAt: number;
    } | undefined {
        try {
            const path = this.path(key);
            if (statSync(path).size > 256 * 1024)
                return undefined;
            const record = JSON.parse(readFileSync(path, 'utf8'));
            const graph = ProjectRepositoryGraph.safeParse(record.value);
            if (record.key !== key || !Number.isFinite(record.savedAt) || !graph.success
                || !['COMPLETE', 'INCOMPLETE'].includes(graph.data.analysisStatus ?? ''))
                return undefined;
            return { value: graph.data, savedAt: record.savedAt };
        }
        catch {
            return undefined;
        }
    }
    write(key: string, value: ProjectRepositoryGraph): void {
        if (!['COMPLETE', 'INCOMPLETE'].includes(value.analysisStatus ?? ''))
            return;
        const bounded = fitRepositoryGraph(value, 192 * 1024);
        if (!bounded) return;
        const json = JSON.stringify({ key, value: bounded, savedAt: this.now() });
        if (Buffer.byteLength(json) > 256 * 1024)
            return;
        try {
            const directory = typeof this.directory === 'function' ? this.directory() : this.directory;
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const path = this.path(key), temporary = path + '.tmp';
            writeFileSync(temporary, json, { mode: 0o600 });
            renameSync(temporary, path);
            const files = readdirSync(directory).filter(name => name.endsWith('.json'))
                .map(name => ({ path: join(directory, name), mtime: statSync(join(directory, name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            for (const file of files.slice(128))
                unlinkSync(file.path);
        }
        catch { /* The live graph remains available when disk storage is unavailable. */ }
    }
    private path(key: string): string {
        const directory = typeof this.directory === 'function' ? this.directory() : this.directory;
        return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
    }
}
