#!/usr/bin/env node
/**
 * A read-only look at which chat started which on this computer, and at the catalog that results.
 *
 * It reads Claude, Codex and Grok history where the providers keep it, decides for every headless chat
 * of the last 48 hours which chat started it (by its request, then by its folder), and prints counts by
 * parent, provider and folder. Then it measures the catalog a monitor would publish now. GrantTap's own
 * state is never read or written: the config folder is a fresh temporary one, removed at the end, so
 * no link is remembered between runs. Ids and folders are printed; requests and transcripts are not.
 *
 *   node --import tsx scripts/diagnostics/started-by-dry-run.ts [--source <tree>] [--catalog-only]
 *
 * `--source` reads the runtime from another tree: an older release, to compare (one without matching by
 * folder matches by request alone); `--catalog-only` skips the rules.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const source = resolve(args.includes("--source") ? args[args.indexOf("--source") + 1]! : ".");
const config = mkdtempSync(join(tmpdir(), "granttap-dry-run-"));
process.env.GRANTTAP_CONFIG_DIR = config;
const load = (path: string) => import(join(source, path));
const NOW = Date.now();
const DAY = 24 * 60 * 60_000;

type Fact = { agent: string; sessionId: string; cwd?: string; startedAt: number; headless?: boolean;
  launches?: Array<{ folder: string; agent: string; firstAt: number; lastAt: number }> };
type Chat = { agent: string; sessionId: string };
type Row = { sessionId: string; agent: string; cwd?: string; state: string; lastActivityAt: number;
  startedBy?: Chat; startedChildren?: Record<string, number>; stopped?: unknown };

const key = (chat: Chat) => `${chat.agent}:${chat.sessionId}`;
const count = <T>(items: readonly T[], by: (item: T) => string) => {
  const out = new Map<string, number>();
  for (const item of items) out.set(by(item), (out.get(by(item)) ?? 0) + 1);
  return [...out.entries()].sort((left, right) => right[1] - left[1]);
};
const print = (title: string, rows: Array<[string, number]>) => {
  console.log(`  ${title}:${rows.length ? "" : " none"}`);
  for (const [label, total] of rows) console.log(`    ${String(total).padStart(5)}  ${label}`);
};

async function rules(): Promise<void> {
  const { scanClaude } = await load("apps/bridge/src/sessions/scan/claude/index.ts");
  const { scanCodex } = await load("apps/bridge/src/sessions/scan/codex/index.ts");
  const { scanGrok } = await load("apps/bridge/src/sessions/scan/grok.ts");
  const { transcriptParent } = await load("apps/bridge/src/started-by/attach.ts");
  // A tree from before matching by folder has only the request.
  const { folderParents, runFolder } = await load("apps/bridge/src/started-by/folders/index.ts")
    .catch(() => ({ folderParents: () => () => undefined, runFolder: () => "-" }));
  // Every chat of the last days, not only the newest 200 a catalog reads, so no parent is missed.
  const scans = [scanClaude(400), scanCodex(4_000), scanGrok(1_000)];
  const facts: Fact[] = scans.flatMap((scan: { lineage?: Fact[] }) => scan.lineage ?? []);
  const recent = facts.filter((fact) => fact.headless && NOW - fact.startedAt <= 2 * DAY);
  console.log(`Chats read: ${count(facts, (fact) => fact.agent).map(([agent, total]) => `${agent} ${total}`).join(", ")}; `
    + `headless in the last 48 h: ${recent.length}`);
  const byFolder = folderParents(facts, NOW);
  const linked = recent.map((child) => {
    const request = transcriptParent(child, facts, NOW) as Chat | undefined;
    const folder = request ? undefined : byFolder(child) as Chat | undefined;
    return { child, parent: request ?? folder, rule: request ? "request" : folder ? "folder" : "" };
  });
  const label = (item: (typeof linked)[number]) => `${item.rule.padEnd(7)} ${key(item.parent!)} <- ${item.child.agent} in ${item.child.cwd}`;
  print("Linked", count(linked.filter((item) => item.parent), label));
  print("Not linked (headless, last 48 h)", count(linked.filter((item) => !item.parent),
    (item) => `${item.child.agent} in ${item.child.cwd} (run folder: ${item.child.cwd ? runFolder(item.child.cwd, NOW) : "-"})`));
  const launchers = new Map<string, Set<string>>();
  for (const fact of facts) {
    for (const launch of fact.launches ?? []) {
      const at = `${launch.agent} in ${launch.folder}`;
      launchers.set(at, (launchers.get(at) ?? new Set()).add(key(fact)));
    }
  }
  print("Folders a provider was started in by more than one chat (they link nothing)",
    [...launchers.entries()].filter(([, chats]) => chats.size > 1).map(([at, chats]) => [`${at}: ${[...chats].join(", ")}`, chats.size]));
}

async function catalog(): Promise<void> {
  const sessions = await load("apps/bridge/src/sessions/index.ts");
  const live: Row[] = sessions.scanSessions().sessions;
  // As the monitor bounds it with nothing pinned: the 40 first, newest first.
  const history: Row[] = (sessions.scanSessionHistory() as Row[]).slice(0, 40).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const status = { type: "sessions.status", machine: "Mac", sessions: live, history, generatedAt: NOW };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  console.log(`Catalog now: ${bytes(status)} bytes; live ${live.length} rows (${bytes(live)} bytes), history ${history.length} rows `
    + `(${bytes(history)} bytes)`);
  for (const [name, rows] of [["live", live], ["history", history]] as const) {
    const children = rows.filter((row) => row.startedBy);
    const parents = rows.filter((row) => row.startedChildren);
    const orphans = rows.filter((row) => row.agent === "codex" && !row.startedBy && row.state === "idle" && row.cwd?.startsWith("/tmp/"));
    console.log(`  ${name}: ${children.length} rows name a parent (${bytes(children)} bytes); `
      + `${orphans.length} finished Codex rows in /tmp name none (${bytes(orphans)} bytes)`);
    for (const parent of parents) console.log(`    ${key(parent)} startedChildren ${JSON.stringify(parent.startedChildren)}`);
  }
  console.log(`  bulk transcript heads a refresh may send: ${live.filter((row) => !(row.startedBy && row.state === "idle")).length} of ${live.length} live rows`);
  const paged: Row[] = sessions.scanSessionHistoryForPaging().sessions;
  console.log(`  history pages (40 a page): ${Math.ceil(paged.length / 40)} for ${paged.length} rows, ${paged.filter((row) => row.startedBy).length} naming a parent`);
}

try {
  if (!args.includes("--catalog-only")) await rules();
  await catalog();
} finally {
  rmSync(config, { recursive: true, force: true });
}
