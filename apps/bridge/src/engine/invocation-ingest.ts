import { createHash } from "node:crypto";
import type { SessionInfo } from "../../../../packages/protocol/schema";
import { inspectRepository, type RepositoryFacts } from "../mesh/catalog";
import { computerId } from "../mesh/computer-identity";
import { repositoryRelative } from "../mesh/observed-claims";
import { claudeTranscriptPaths } from "../sessions/claude";
import { codexTranscriptPaths } from "../sessions/codex";
import { cursorFiles } from "../sessions/cursor/scan";
import { configDir } from "../config/paths";
import { join } from "node:path";
import { invocationDecisionPath } from "../policy/decision-log";
import { EngineClient } from "./engine-client";
import { engineFeatureEnabled } from "./engine-supervisor";
import { readInvocationBatch, type InvocationLogCursor } from "./invocation-log-reader";
import {
  parseInvocationLine, sourceGapFact, type InvocationFact, type InvocationParseState,
} from "./invocation-parse";
import type { InvocationEvent } from "./engine-invocation-protocol";
import { parseInvocationDecision } from "./invocation-decision-parse";

type Provider = "claude" | "codex" | "cursor";
type SourceState = { cursor: InvocationLogCursor; parse: InvocationParseState };
type Client = Pick<EngineClient, "request">;

export type InvocationIngestOptions = {
  client: Client;
  enabled: () => boolean;
  computer: () => string;
  paths: (session: SessionInfo) => string[];
  inspect: (cwd: string) => RepositoryFacts;
  decisionPath?: (session: SessionInfo) => string;
};

function transcriptPaths(session: SessionInfo): string[] {
  if (session.agent === "claude") return claudeTranscriptPaths(session.sessionId);
  if (session.agent === "codex") return codexTranscriptPaths(session.sessionId);
  if (session.agent === "cursor") return cursorFiles(session.sessionId)?.map((file) => file.path) ?? [];
  return [];
}

export function createInvocationIngestor(options: InvocationIngestOptions) {
  const states = new Map<string, SourceState>();
  const decisionStates = new Map<string, InvocationLogCursor>();
  return {
    async ingest(sessions: readonly SessionInfo[]): Promise<number> {
      if (!options.enabled()) return 0;
      const candidates = sessions.filter((session) => session.projectId && session.taskId
        && ["claude", "codex", "cursor"].includes(session.agent));
      if (candidates.length === 0) return 0;
      try { await options.client.request({ operation: "engine.ping" }, { timeoutMs: 200 }); }
      catch { return 0; }
      let accepted = 0;
      for (const session of candidates) {
        const provider = session.agent as Provider;
        const facts = session.cwd ? options.inspect(session.cwd) : undefined;
        for (const path of options.paths(session)) {
          const key = `${provider}\0${session.sessionId}\0${path}`;
          const known = states.get(key);
          let batch;
          try { batch = readInvocationBatch(path, known?.cursor); }
          catch { continue; }
          const parse: InvocationParseState = {
            pending: new Map(known?.parse.pending ?? []),
          };
          const records = [
            ...batch.gaps.map((offset) => ({ offset, gap: true as const })),
            ...batch.lines.map((row) => ({ ...row, gap: false as const })),
          ].sort((a, b) => a.offset - b.offset || Number(b.gap) - Number(a.gap));
          const thread = hash([path]);
          const events: InvocationEvent[] = [];
          for (const record of records) {
            if (record.gap) parse.pending.clear();
            const observed = record.gap
              ? [sourceGapFact(record.offset)]
              : parseInvocationLine(provider, record.line, parse, record.offset);
            for (const fact of observed) {
              events.push(eventFor(session, provider, options.computer(), thread, record.offset, fact, facts));
            }
          }
          try {
            for (const event of events) {
              await options.client.request({ operation: "invocation.observe", input: event });
              accepted += 1;
            }
          } catch {
            // No cursor advance: the next pass replays this batch under stable
            // event IDs. Engine deduplicates already committed evidence.
            return accepted;
          }
          states.set(key, { cursor: batch.next, parse });
        }
        const decisionPath = options.decisionPath?.(session);
        if (decisionPath) {
          const key = `${provider}\0${session.sessionId}\0${decisionPath}`;
          let batch;
          try { batch = readInvocationBatch(decisionPath, decisionStates.get(key)); }
          catch { continue; }
          const thread = hash([decisionPath]);
          const events = [
            ...batch.gaps.map((offset) => ({ offset, gap: true as const })),
            ...batch.lines.map((row) => ({ ...row, gap: false as const })),
          ].sort((a, b) => a.offset - b.offset).flatMap((record) =>
            (record.gap ? [sourceGapFact(record.offset)]
              : parseInvocationDecision(record.line, provider, record.offset))
              .map((fact) => eventFor(session, provider, options.computer(), thread, record.offset, fact, facts)));
          try {
            for (const event of events) {
              await options.client.request({ operation: "invocation.observe", input: event });
              accepted += 1;
            }
          } catch { return accepted; }
          decisionStates.set(key, batch.next);
        }
      }
      return accepted;
    },
  };
}

function eventFor(
  session: SessionInfo, provider: Provider, computer: string,
  thread: string, offset: number, fact: InvocationFact, repository?: RepositoryFacts,
): InvocationEvent {
  // A native session may be observed again after handoff. The computer is part
  // of the Execution identity, while Cursor child transcripts also need their
  // thread path to avoid reusing a call ID from a sibling conversation.
  const invocationId = hash([computer, provider, session.sessionId,
    provider === "cursor" || fact.phase === "source_gap" ? thread : "", fact.callId]);
  const resource = fact.resource && repository
    ? repositoryRelative(fact.resource, repository.root) : undefined;
  return {
    event_id: hash([invocationId, thread, String(offset), fact.phase, fact.source,
      resource ?? "", String(fact.occurredAt)]),
    invocation_id: invocationId,
    project_id: session.projectId!,
    task_id: session.taskId!,
    execution_id: hash([computer, provider, session.sessionId]),
    provider, native_call_id: fact.callId, session_id: session.sessionId,
    tool_name: fact.toolName,
    phase: fact.phase, source: fact.source, occurred_at: fact.occurredAt,
    repository_id: repository?.canonicalRepositoryId,
    worktree: session.worktree ?? repository?.worktree,
    resource,
    policy_revision: fact.policyRevision,
    policy_rule_id: fact.policyRuleId,
    capability_artifact_hash: fact.capabilityArtifactHash,
  };
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

const defaultClient = new EngineClient({ socketPath: join(configDir(), "engine.sock") });
const defaultIngestor = createInvocationIngestor({
  client: defaultClient, enabled: engineFeatureEnabled, computer: computerId,
  paths: transcriptPaths, inspect: inspectRepository,
  decisionPath: (session) => invocationDecisionPath(session.sessionId),
});

let ongoing: Promise<number> | undefined;

export function ingestRuntimeInvocations(sessions: readonly SessionInfo[]): Promise<number> {
  if (ongoing) return ongoing;
  ongoing = defaultIngestor.ingest(sessions).finally(() => { ongoing = undefined; });
  return ongoing;
}
