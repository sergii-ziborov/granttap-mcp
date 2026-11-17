/** Real folders and file events for the watch's tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function folder(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-run-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Write a new rollout every 200 ms until the watch samples: a stream only hears what follows its start. */
export async function heardWithin(root: string, sampled: () => number, ms: number): Promise<number> {
  const day = join(root, "2026", "11", "17");
  mkdirSync(day, { recursive: true });
  const before = sampled();
  for (let index = 0; index * 200 < ms; index += 1) {
    const written = Date.now();
    writeFileSync(join(day, `rollout-2026-11-17T12-11-29-warm-${index}.jsonl`), "{}\n");
    while (Date.now() - written < 200) {
      if (sampled() > before) return Date.now() - written;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`no sample within ${ms} ms`);
}

