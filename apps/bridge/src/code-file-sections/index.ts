/**
 * Every section of one file of a repository's code map, read from the Engine on demand. The Mesh
 * snapshot keeps a bounded overview of each repository; this answers for the one file a person opened.
 */
import type { ProjectCodeFileStatus } from "../../../../packages/protocol/schema";
import type { EngineCodeFile } from "../engine/protocol/code-file";
import type { CodeFileRead } from "../engine/runtime/repository-graph/code-file";

export type CodeFileKey = { projectId: string; repositoryId: string; path: string };
export type CodeFileAnswer =
  | { status: "ok"; file: EngineCodeFile }
  | { status: Exclude<ProjectCodeFileStatus, "ok"> };
export type AnalysisOutcome = "ok" | "not_bound" | "engine_unavailable" | "analysis_failed";
export type CodeFileRecipient = { requestId: string; peerPublicKey?: string };
export type CodeFileDeliver = (recipient: CodeFileRecipient, answer: CodeFileAnswer) => Promise<void>;

export type CodeFileSectionsDependencies = {
  /** This computer holds a binding of the repository in the Project; read from local state only. */
  bound: (projectId: string, repositoryId: string) => boolean;
  /** `graph.code_file`, a read of the Engine's memory. */
  read: (key: CodeFileKey) => Promise<CodeFileRead>;
  /** `graph.analyze_repository` for this computer's checkout, joining a job already running. */
  analyze: (projectId: string, repositoryId: string) => Promise<AnalysisOutcome>;
  now: () => number;
};

type Waiting = { recipient: CodeFileRecipient; deliver: CodeFileDeliver };
type Query = { waiting: Waiting[]; analyzing: boolean };
type Analysis = { done: Promise<AnalysisOutcome>; outcome?: AnalysisOutcome; finishedAt?: number };

/** Files answered at once; a further query is refused until one finishes. */
export const MAX_CODE_FILE_QUERIES = 32;
/** Requests for the same file that share one answer. */
const MAX_JOINED_REQUESTS = 8;
/** A finished analysis is the answer for this long: a poll does not start the same failing scan again. */
const ANALYSIS_MEMORY_MS = 30_000;
const MAX_ANALYSES = 64;

export class CodeFileSections {
  private readonly queries = new Map<string, Query>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly analyses = new Map<string, Analysis>();

  constructor(private readonly deps: CodeFileSectionsDependencies, private readonly capacity = MAX_CODE_FILE_QUERIES) {}

  /**
   * Answers a phone. The first answer goes out before this resolves: the file's sections, a reason
   * there are none, or `analyzing` when the Engine must analyse first; the final answer follows then.
   * The same file asked again while it is being answered shares that answer. Returns false when it
   * could not be taken.
   */
  async ask(key: CodeFileKey, recipient: CodeFileRecipient, deliver: CodeFileDeliver): Promise<boolean> {
    const id = JSON.stringify([key.projectId, key.repositoryId, key.path]);
    const running = this.queries.get(id);
    if (running) {
      if (running.waiting.some(item => item.recipient.requestId === recipient.requestId)) return true;
      if (running.waiting.length >= MAX_JOINED_REQUESTS) return false;
      running.waiting.push({ recipient, deliver });
      if (running.analyzing) {
        await Promise.resolve().then(() => deliver(recipient, { status: "analyzing" })).catch(() => {});
      }
      return true;
    }
    if (this.queries.size >= this.capacity) return false;
    const query: Query = { waiting: [{ recipient, deliver }], analyzing: false };
    this.queries.set(id, query);
    let firstSent!: () => void;
    const first = new Promise<void>(resolve => { firstSent = resolve; });
    void this.answer(key, query, firstSent).catch(() => {}).finally(() => {
      this.queries.delete(id);
      firstSent();
    });
    await first;
    return true;
  }

  /** One answer without waiting for an analysis: a miss starts one and says `analyzing`; ask again. */
  async poll(key: CodeFileKey): Promise<CodeFileAnswer> {
    if (!this.deps.bound(key.projectId, key.repositoryId)) return { status: "not_bound" };
    const read = await this.read(key);
    if (read.kind !== "not_cached") return answerFor(read);
    const analysis = this.analysis(key);
    if (analysis.outcome === undefined) return { status: "analyzing" };
    if (analysis.outcome !== "ok") return { status: analysis.outcome };
    // The analysis may have finished just after the read above missed.
    const again = await this.read(key);
    return again.kind === "not_cached" ? { status: "analysis_failed" } : answerFor(again);
  }

  private async answer(key: CodeFileKey, query: Query, firstSent: () => void): Promise<void> {
    if (!this.deps.bound(key.projectId, key.repositoryId)) return this.send(query, { status: "not_bound" });
    let read = await this.read(key);
    if (read.kind === "not_cached") {
      const analysis = this.analysis(key);
      if (analysis.outcome === undefined) {
        await this.send(query, { status: "analyzing" });
        query.analyzing = true;
        firstSent();
      }
      const outcome = await analysis.done;
      if (outcome !== "ok") return this.send(query, { status: outcome });
      read = await this.read(key);
    }
    // Memory still empty after a finished analysis: that analysis did not give this Engine the file.
    await this.send(query, read.kind === "not_cached" ? { status: "analysis_failed" } : answerFor(read));
  }

  private async send(query: Query, answer: CodeFileAnswer): Promise<void> {
    // A request that joins while answers go out is still in this list when its turn comes.
    for (const item of query.waiting) {
      try { await item.deliver(item.recipient, answer); } catch { /* One phone's failed send never stops the rest. */ }
    }
  }

  /** At most one Engine read per repository at a time; reads of other repositories do not wait. */
  private read(key: CodeFileKey): Promise<CodeFileRead> {
    const lane = JSON.stringify([key.projectId, key.repositoryId]);
    const work = async (): Promise<CodeFileRead> => {
      try { return await this.deps.read(key); } catch { return { kind: "engine_unavailable" }; }
    };
    const result = (this.lanes.get(lane) ?? Promise.resolve()).then(work);
    const settled = result.then(() => {});
    this.lanes.set(lane, settled);
    void settled.then(() => { if (this.lanes.get(lane) === settled) this.lanes.delete(lane); });
    return result;
  }

  /** The repository's analysis now running, or the one that just finished, or a new one. */
  private analysis(key: CodeFileKey): Analysis {
    const id = JSON.stringify([key.projectId, key.repositoryId]);
    const known = this.analyses.get(id);
    const now = this.deps.now();
    if (known && (known.outcome === undefined || now - known.finishedAt! < ANALYSIS_MEMORY_MS)) return known;
    for (const [other, entry] of this.analyses) {
      if (entry.outcome !== undefined && now - entry.finishedAt! >= ANALYSIS_MEMORY_MS) this.analyses.delete(other);
    }
    if (this.analyses.size >= MAX_ANALYSES) this.analyses.delete(this.analyses.keys().next().value!);
    const entry: Analysis = { done: Promise.resolve("analysis_failed") };
    entry.done = Promise.resolve().then(() => this.deps.analyze(key.projectId, key.repositoryId))
      .catch((): AnalysisOutcome => "analysis_failed")
      .then(outcome => { entry.outcome = outcome; entry.finishedAt = this.deps.now(); return outcome; });
    this.analyses.set(id, entry);
    return entry;
  }
}

function answerFor(read: Exclude<CodeFileRead, { kind: "not_cached" }>): CodeFileAnswer {
  return read.kind === "ok" ? { status: "ok", file: read.file } : { status: read.kind };
}
