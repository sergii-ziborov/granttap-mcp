import { inspectRepositoryAsync, inspectWorkingTreeAsync } from '../repository-inspection';
import { inspectRepository, hasUncommittedWork, type RepositoryFacts } from '..';

type Readers = { repository: (cwd: string) => Promise<RepositoryFacts>;
  workingTree: (cwd: string) => Promise<boolean | undefined>; now: () => number };
export type CatalogInspection = { repository: (cwd: string) => RepositoryFacts;
  workingTree: (cwd: string) => boolean | undefined };
type Observation = { facts: RepositoryFacts; observedAt: number; expiresAt: number };

/** Observation only. Explicit Git and transfer operations continue to inspect native state freshly. */
export function createMonitorInspection(readers: Readers = {
  repository: inspectRepositoryAsync, workingTree: inspectWorkingTreeAsync, now: Date.now,
}) {
  const metadata = new Map<string, Observation>();
  const pending = new Map<string, Promise<RepositoryFacts>>();
  let admitted = new Set<string>();
  const repository = (cwd: string, force: boolean): Promise<RepositoryFacts> => {
    const cached = metadata.get(cwd);
    if (!force && cached && readers.now() >= cached.observedAt && readers.now() < cached.expiresAt) return Promise.resolve(cached.facts);
    const active = pending.get(cwd);
    if (!force && active) return active;
    const next = readers.repository(cwd).then(facts => {
      const observed = Object.freeze({ ...facts }), now = readers.now();
      if (pending.get(cwd) === next && admitted.has(cwd) && (metadata.has(cwd) || metadata.size < 512)) {
        metadata.set(cwd, { facts: observed, observedAt: now, expiresAt: now + (facts.worktree ? 30_000 : 5_000) });
      }
      return observed;
    }).finally(() => { if (pending.get(cwd) === next) pending.delete(cwd); });
    pending.set(cwd, next);
    return next;
  };
  return async (directories: string[], force = false): Promise<CatalogInspection> => {
    admitted = new Set(directories);
    for (const cwd of metadata.keys()) if (!admitted.has(cwd)) metadata.delete(cwd);
    const values = new Map(await Promise.all([...admitted].map(async cwd => {
      const [facts, workingTree] = await Promise.all([repository(cwd, force), readers.workingTree(cwd)]);
      return [cwd, { repository: facts, workingTree }] as const;
    })));
    return { repository: cwd => values.get(cwd)?.repository ?? inspectRepository(cwd),
      workingTree: cwd => values.has(cwd) ? values.get(cwd)!.workingTree : hasUncommittedWork(cwd) };
  };
}

export const prepareMonitorInspection = createMonitorInspection();
