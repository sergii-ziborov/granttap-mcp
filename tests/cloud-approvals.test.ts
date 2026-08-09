import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelCloudApproval,
  cardFromApprovalRequest,
  httpRelayBase,
  listCloudApprovals,
  publishCloudApproval,
  validatedCloudPageUrl,
  waitCloudApprovalDecision,
} from "../apps/bridge/src/cloud-approvals";
import type { PeerConfig } from "../packages/core/relay-client";
import type { ApprovalRequest } from "../packages/protocol/schema";

const cfg: PeerConfig = {
  relayUrl: "wss://granttap-relay.example.workers.dev",
  room: "ab".repeat(16),
  role: "machine",
  deviceName: "test",
  senderId: "machine-1",
  myPublicKey: "x",
  mySecretKey: "y",
  peerPublicKey: "z",
  pushAuth: "cd".repeat(32),
};

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(typeof input === "string" ? input : input.toString(), init)) as typeof fetch;
}

describe("cloud approvals", () => {
  it("converts relay URLs without retaining query or fragment", () => {
    assert.equal(
      httpRelayBase("wss://granttap-relay.example.workers.dev/?room=x#fragment"),
      "https://granttap-relay.example.workers.dev",
    );
    assert.equal(httpRelayBase("ws://localhost:8787"), "http://localhost:8787");
    assert.equal(httpRelayBase("https://relay.example/path/"), "https://relay.example/path");
    assert.equal(
      validatedCloudPageUrl(
        cfg.relayUrl,
        "https://granttap-relay.example.workers.dev/a/room/private-token",
      ),
      "https://granttap-relay.example.workers.dev/a/room/private-token",
    );
    assert.equal(validatedCloudPageUrl(cfg.relayUrl, "https://evil.example/a/token"), null);
    assert.equal(
      validatedCloudPageUrl(cfg.relayUrl, "https://user:secret@granttap-relay.example.workers.dev/a"),
      null,
    );
  });

  it("builds a bounded card and infers destructive commands", () => {
    const request: ApprovalRequest = {
      type: "approval.request",
      requestId: "req-card",
      agent: "cursor",
      kind: "permission",
      tool: "Shell",
      title: "Allow shell?",
      command: "rm -rf /tmp/example",
      cwd: "/tmp",
      sessionId: "chat-a",
      risk: "high",
      createdAt: 1,
    };
    const card = cardFromApprovalRequest(request, { ttlMs: 60_000 });
    assert.equal(card.danger, "destructive");
    assert.equal(card.requestId, request.requestId);
    assert.equal(card.sessionId, request.sessionId);
    assert.equal(card.ttlMs, 60_000);
  });

  it("publishes, lists, decides, and cancels with relay authentication", async () => {
    const methods: string[] = [];
    let listCalls = 0;
    const fetchImpl = mockFetch(async (url, init) => {
      methods.push(init?.method ?? "GET");
      assert.match(url, /\/approvals\?room=/);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${cfg.pushAuth}`,
      );
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { requestId?: string };
        assert.equal(body.requestId, "req-roundtrip");
        return Response.json({
          ok: true,
          pageUrl: "https://granttap-relay.example.workers.dev/a/room/token",
          viewToken: "ef".repeat(32),
        });
      }
      if (init?.method === "DELETE") {
        assert.match(url, /requestId=req-roundtrip/);
        return Response.json({ ok: true });
      }
      listCalls += 1;
      return Response.json({
        ok: true,
        pageUrl: "https://granttap-relay.example.workers.dev/a/room/token",
        approvals: [{
          requestId: "req-roundtrip",
          status: listCalls < 2 ? "pending" : "allow",
          decidedBy: "web",
          danger: "dangerous",
        }],
      });
    });

    const published = await publishCloudApproval(cfg, {
      requestId: "req-roundtrip",
      danger: "caution",
      title: "Allow shell?",
      command: "ls",
      agent: "cursor",
    }, fetchImpl);
    assert.equal(published.ok, true);
    assert.match(published.pageUrl ?? "", /\/a\//);

    const listed = await listCloudApprovals(cfg, fetchImpl);
    assert.equal(listed.ok, true);
    assert.equal(listed.approvals[0]?.danger, "dangerous");
    const decision = await waitCloudApprovalDecision(
      cfg,
      "req-roundtrip",
      1_000,
      fetchImpl,
      1,
    );
    assert.equal(decision?.decision, "allow");
    assert.equal(decision?.decidedBy, "web");
    assert.equal(await cancelCloudApproval(cfg, "req-roundtrip", fetchImpl), true);
    assert.deepEqual(methods.includes("PUT"), true);
    assert.deepEqual(methods.includes("DELETE"), true);
  });

  it("fails closed when unconfigured and absorbs HTTP/network errors", async () => {
    const bare = { ...cfg, pushAuth: undefined };
    assert.equal((await publishCloudApproval(bare, {
      requestId: "missing",
      danger: "safe",
      title: "t",
      agent: "cursor",
    })).ok, false);
    assert.equal((await listCloudApprovals(bare)).ok, false);
    assert.equal(await cancelCloudApproval(bare, "missing"), false);

    const unauthorized = mockFetch(async () =>
      Response.json({ error: "denied" }, { status: 401 }));
    assert.equal((await publishCloudApproval(cfg, {
      requestId: "http-error",
      danger: "safe",
      title: "t",
      agent: "cursor",
    }, unauthorized)).ok, false);
    assert.equal((await listCloudApprovals(cfg, unauthorized)).ok, false);

    const offline = mockFetch(async () => { throw new Error("offline"); });
    assert.equal((await listCloudApprovals(cfg, offline)).ok, false);
    assert.equal(await cancelCloudApproval(cfg, "offline", offline), false);
  });

  it("times out and aborts pending decision polling promptly", async () => {
    const pending = mockFetch(async () =>
      Response.json({ ok: true, approvals: [{ requestId: "req-pending", status: "pending" }] }));
    assert.equal(
      await waitCloudApprovalDecision(cfg, "req-pending", 30, pending, 5),
      null,
    );

    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = waitCloudApprovalDecision(
      cfg,
      "req-abort",
      5_000,
      pending,
      1_000,
      controller.signal,
    );
    controller.abort();
    assert.equal(await waiting, null);
    assert.ok(Date.now() - startedAt < 250);
  });

  it("aborts hanging fetches and stalled response bodies", async () => {
    const controller = new AbortController();
    const hanging = mockFetch(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      }));
    const startedAt = Date.now();
    const publishing = publishCloudApproval(cfg, {
      requestId: "req-fetch-abort",
      danger: "safe",
      title: "t",
      agent: "cursor",
    }, hanging, controller.signal);
    controller.abort();
    assert.equal((await publishing).ok, false);
    assert.ok(Date.now() - startedAt < 250);

    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"ok":true'));
      },
      cancel() { bodyCancelled = true; },
    });
    const headersOnly = mockFetch(async () => new Response(stream));
    const bodyController = new AbortController();
    const stalled = publishCloudApproval(cfg, {
      requestId: "req-body-abort",
      danger: "safe",
      title: "t",
      agent: "cursor",
    }, headersOnly, bodyController.signal);
    setTimeout(() => bodyController.abort(), 10);
    assert.equal((await stalled).ok, false);
    assert.equal(bodyCancelled, true);
  });

  it("rejects oversized relay bodies before exposing their contents", async () => {
    const oversized = mockFetch(async () =>
      Response.json({ padding: "x".repeat(70 * 1024) }));
    const result = await publishCloudApproval(cfg, {
      requestId: "req-large",
      danger: "safe",
      title: "t",
      agent: "cursor",
    }, oversized);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /too large/);
  });
});
