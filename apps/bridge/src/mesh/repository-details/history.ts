import type { ProjectRepositoryDetails } from "../../../../../packages/protocol/schema";
import { git } from "./git";

type History = Pick<ProjectRepositoryDetails, "commits" | "contributors" | "commitCount" | "contributorCount">;
const cached = new Map<string, { value: History; at: number }>();
const pending = new Map<string, Promise<History>>();
const clean = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);

async function read(path: string, revision?: string): Promise<History> {
  const reference = revision ?? "HEAD";
  const [history, shortlog, count] = await Promise.all([
    git(path, ["log", "-8", "--format=%H%x1f%an%x1f%ct%x1f%s%x1e", reference]),
    git(path, ["shortlog", "-sn", reference]), git(path, ["rev-list", "--count", reference]),
  ]);
  const commits = (history ?? "").split("\u001e").flatMap(row => {
    const [sha, author, time, subject] = row.trim().split("\u001f");
    return sha && /^[a-f0-9]{40,64}$/.test(sha) && Number.isFinite(Number(time)) && Number(time) >= 0
      ? [{ sha, author: clean(author ?? "", 160), subject: clean(subject ?? "", 240), committedAt: Number(time) * 1_000 }] : [];
  });
  const contributors = (shortlog ?? "").split("\n").flatMap(row => {
    const match = row.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ name: clean(match[2]!, 160), commits: Number(match[1]) }] : [];
  });
  return { commits, contributors: contributors.slice(0, 12),
    commitCount: count == null ? (revision ? undefined : 0) : Number(count),
    contributorCount: shortlog == null ? (revision ? undefined : 0) : contributors.length };
}

/** Only background history is reused; checkout metadata and working-tree state remain fresh. */
export async function repositoryHistory(path: string, revision: string | undefined, background: boolean): Promise<History> {
  const key = JSON.stringify([path, revision]), previous = cached.get(key), now = Date.now();
  if (background && previous && now >= previous.at && now - previous.at < 30_000) {
    return structuredClone(previous.value);
  }
  const active = pending.get(key);
  if (background && active) return structuredClone(await active);
  const next = read(path, revision).then(value => {
    if (pending.get(key) === next) {
      cached.delete(key);
      if (cached.size >= 128) cached.delete(cached.keys().next().value!);
      cached.set(key, { value: structuredClone(value), at: Date.now() });
    }
    return value;
  }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return structuredClone(await next);
}
