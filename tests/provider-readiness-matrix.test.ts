import assert from "node:assert/strict";
import test from "node:test";
import {
  providerStatuses,
  type ProviderReadiness,
} from "../apps/mcp/src/provider-status";

function readiness(overrides: Partial<ProviderReadiness> = {}): ProviderReadiness {
  return {
    cursor: { installed: true, hookConfigured: true },
    integrations: [
      { agent: "claude", installed: true, hookConfigured: true },
      { agent: "codex", installed: true, hookConfigured: true },
      { agent: "grok", installed: true, hookConfigured: true },
    ],
    paired: true,
    monitor: { configured: true, running: true },
    ...overrides,
  };
}

function detailFor(statuses: ReturnType<typeof providerStatuses>, id: string): string {
  return statuses.find((status) => status.id === id)?.detail ?? "";
}

test("an unpaired computer asks every configured provider for one pairing action", () => {
  const statuses = providerStatuses(readiness({ paired: false }));
  assert.deepEqual(statuses.map((status) => status.status), [
    "action_required", "action_required", "action_required", "action_required",
  ]);
  for (const id of ["cursor", "claude", "codex", "grok"]) {
    assert.match(detailFor(statuses, id), /not paired\. Run granttap connect/);
  }
});

test("a configured hook without its CLI is reported as action required, not connected", () => {
  const statuses = providerStatuses(readiness({
    integrations: [
      { agent: "claude", installed: false, hookConfigured: true },
      { agent: "codex", installed: false, hookConfigured: false },
      { agent: "grok", installed: false, hookConfigured: true },
    ],
  }));
  assert.equal(statuses.find((status) => status.id === "claude")?.status, "action_required");
  assert.match(detailFor(statuses, "claude"), /CLI is unavailable on PATH/);
  assert.equal(statuses.find((status) => status.id === "codex")?.status, "not_configured");
  assert.match(detailFor(statuses, "codex"), /Install Codex/);
  assert.equal(statuses.find((status) => status.id === "grok")?.status, "not_configured");
  assert.match(detailFor(statuses, "grok"), /Install Grok Build/);
});

test("background sync and Cursor authorization are separate readiness answers", () => {
  const noMonitor = providerStatuses(readiness({ monitor: { configured: false, running: false } }));
  assert.match(detailFor(noMonitor, "grok"), /background sync is not configured/);

  const authorized = providerStatuses(readiness({
    cursorOAuth: { configured: true, persistent: true, healthy: true },
  }));
  assert.equal(authorized.find((status) => status.id === "cursor")?.status, "connected");
  assert.match(detailFor(authorized, "cursor"), /persistent OAuth endpoint/);

  const unauthorized = providerStatuses(readiness());
  assert.match(detailFor(unauthorized, "cursor"), /Run granttap setup for Cursor authorization/);
  assert.equal(unauthorized.find((status) => status.id === "claude")?.status, "connected");
  assert.equal(unauthorized.find((status) => status.id === "grok")?.status, "connected");
});
