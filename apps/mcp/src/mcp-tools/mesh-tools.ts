import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as actions from "./mesh-actions";

const id = z.string().trim().min(1).max(128);
const detail = z.string().trim().min(1).max(1_000);
const path = z.string().trim().min(1).max(1_024);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/i);
const scope = { actorId: id, projectId: id, taskId: id };
const changes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function run(work: () => unknown | Promise<unknown>) {
  try { return output(await work()); } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Mesh operation failed" }],
    };
  }
}

export function registerGrokBotMeshTools(server: McpServer): void {
  server.registerTool("mesh_status", {
    description: "Read compact task, owner, dependency, claim, and event state for one allowed Project.",
    inputSchema: { actorId: id, projectId: id }, annotations: reads,
  }, (input) => run(() => actions.status(input)));

  server.registerTool("mesh_task", {
    description: "Read bounded state for one authorized Mesh Task; transcripts and hidden reasoning are excluded.",
    inputSchema: scope, annotations: reads,
  }, (input) => run(() => actions.task(input)));

  server.registerTool("mesh_progress", {
    description: "Publish one concise progress fact for the Task owned by this actor.",
    inputSchema: { ...scope, summary: detail }, annotations: changes,
  }, ({ summary, ...input }) => run(() => actions.progress(input, summary)));

  server.registerTool("mesh_claim", {
    description: "Claim a bounded task resource with TTL; overlapping active claims fail before publication.",
    inputSchema: {
      ...scope, resource: path,
      ttlSeconds: z.number().int().min(60).max(3_600).default(900),
    }, annotations: changes,
  }, ({ resource, ttlSeconds, ...input }) => run(() => actions.claim(input, resource, ttlSeconds)));

  server.registerTool("mesh_release", {
    description: "Release one claim owned by this actor's current Task execution.",
    inputSchema: { ...scope, claimId: id }, annotations: changes,
  }, ({ claimId, ...input }) => run(() => actions.release(input, claimId)));

  server.registerTool("mesh_question", {
    description: "Ask a short task-scoped agent question. Technical questions do not interrupt the user.",
    inputSchema: {
      ...scope, question: detail, targetSessionId: id.optional(),
      category: z.enum(["technical", "product", "business", "security", "destructive"])
        .default("technical"),
    }, annotations: changes,
  }, ({ question, targetSessionId, category, ...input }) =>
    run(() => actions.question(input, question, targetSessionId, category)));

  server.registerTool("mesh_answer", {
    description: "Answer one available task-scoped agent question with a concise explicit fact.",
    inputSchema: { ...scope, questionEventId: id, answer: detail }, annotations: changes,
  }, ({ questionEventId, answer, ...input }) =>
    run(() => actions.answer(input, questionEventId, answer)));

  server.registerTool("mesh_artifact_ready", {
    description: "Publish one repository, commit, or external artifact reference without uploading a source tree.",
    inputSchema: { ...scope, reference: path }, annotations: changes,
  }, ({ reference, ...input }) => run(() => actions.artifact(input, reference)));

  server.registerTool("mesh_complete", {
    description: "Mark the actor's current Task execution complete with a concise result summary.",
    inputSchema: { ...scope, summary: detail }, annotations: changes,
  }, ({ summary, ...input }) => run(() => actions.complete(input, summary)));

  server.registerTool("mesh_accept_handoff", {
    description: "Accept one handoff explicitly addressed to this actor while preserving the Task id.",
    inputSchema: { ...scope, requestEventId: id }, annotations: changes,
  }, ({ requestEventId, ...input }) => run(() => actions.accept(input, requestEventId)));

  server.registerTool("mesh_reject_handoff", {
    description: "Reject one handoff addressed to this actor with a bounded explicit reason.",
    inputSchema: { ...scope, requestEventId: id, reason: detail }, annotations: changes,
  }, ({ requestEventId, reason, ...input }) => run(() => actions.reject(input, requestEventId, reason)));

  server.registerTool("mesh_handoff", {
    description: "Handoff this same Task to an existing local coding agent using a bounded Task Capsule.",
    inputSchema: {
      ...scope, targetProvider: z.enum(["claude", "codex", "cursor", "grok"]),
      targetComputer: id, currentStatus: detail, baseSha: sha,
      branch: z.string().trim().min(1).max(512).optional(), latestCommit: sha.optional(),
      filesChanged: z.array(path).max(64).default([]), testsStatus: detail.optional(),
      remainingWork: z.array(detail).max(32).default([]),
      importantDecisions: z.array(detail).max(16).default([]),
    }, annotations: changes,
  }, ({ actorId, projectId, taskId, ...input }) =>
    run(() => actions.handoff({ actorId, projectId, taskId }, input)));
}
