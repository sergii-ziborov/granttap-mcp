import { isUtf8 } from 'node:buffer';
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionInfo } from '../../../../packages/protocol/schema';
export type TaskWorkspaceQuery = {
    mode: 'directory' | 'file';
    path: string;
    offset?: number;
};
export type TaskWorkspaceEntry = {
    path: string;
    name: string;
    kind: 'directory' | 'file';
    size?: number;
};
export type TaskWorkspaceRead = {
    path: string;
    entries?: TaskWorkspaceEntry[];
    text?: string;
    truncated: boolean;
    nextOffset?: number;
};
const protectedPath = (path: string) => path.split('/').some(part => /^\.env(?:\.|$)/i.test(part)
    || ['.git', '.ssh', '.aws', '.private_keys', '.codex', '.claude', '.cursor', '.granttap', '.nodvox'].includes(part)
    || /\.(?:p8|pem|key)$/i.test(part));
function admittedPath(root: string, path: string): string | undefined {
    if (path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path)
        || path.split('/').includes('..') || protectedPath(path))
        return undefined;
    try {
        const target = realpathSync(resolve(root, path));
        const within = relative(root, target);
        return within === '..' || within.startsWith('..' + sep) || isAbsolute(within)
            || protectedPath(within.split(sep).join('/')) ? undefined : target;
    }
    catch {
        return undefined;
    }
}
/** Only the exact known native execution's workspace is readable. */
export function readTaskWorkspace(session: SessionInfo, query: TaskWorkspaceQuery): TaskWorkspaceRead | undefined {
    const path = session.worktree ?? session.cwd;
    if (!path || !['directory', 'file'].includes(query.mode))
        return undefined;
    try {
        const root = realpathSync(path), target = admittedPath(root, query.path);
        if (!target || !statSync(root).isDirectory())
            return undefined;
        const offset = query.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
            return undefined;
        if (query.mode === 'file')
            return file(target, query.path, offset);
        if (!statSync(target).isDirectory())
            return undefined;
        const entries = readdirSync(target).flatMap(name => {
            const path = query.path ? query.path + '/' + name : name;
            const full = admittedPath(root, path);
            if (!full)
                return [];
            const info = statSync(full);
            if (!info.isDirectory() && !info.isFile())
                return [];
            return [{ path, name, kind: info.isDirectory() ? 'directory' as const : 'file' as const,
                    ...(info.isFile() ? { size: info.size } : {}) }];
        }).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
        const next = offset + 200, truncated = next < entries.length;
        return { path: query.path, entries: entries.slice(offset, next), truncated,
            ...(truncated ? { nextOffset: next } : {}) };
    }
    catch {
        return undefined;
    }
}
function file(target: string, path: string, offset: number): TaskWorkspaceRead | undefined {
    const info = lstatSync(target);
    if (!info.isFile() || offset > info.size)
        return undefined;
    const fd = openSync(target, 'r');
    try {
        const bytes = Buffer.alloc(Math.min(info.size - offset, 128 * 1024));
        const count = readSync(fd, bytes, 0, bytes.length, offset);
        let read = bytes.subarray(0, count);
        // A bounded preview may end inside a UTF8 character; invalid interior bytes remain refused.
        if (info.size > offset + count)
            for (let trim = 1; trim <= 3 && !isUtf8(read); trim++)
                read = bytes.subarray(0, count - trim);
        if (!isUtf8(read) || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(read.toString('utf8')))
            return undefined;
        const next = offset + read.length, truncated = info.size > next;
        return { path, text: read.toString('utf8'), truncated, ...(truncated ? { nextOffset: next } : {}) };
    }
    finally {
        closeSync(fd);
    }
}
