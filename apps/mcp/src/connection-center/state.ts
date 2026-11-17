import { z } from "zod";
import { computerDisplayName } from "../../../../packages/core/computer-name";
import { loadConfig } from "../../../bridge/src/config";
import { isMachineConfigured, listPairedPhones, readOnlyMachineConfigPath } from "../status/pairing-status";
import { inspectProviderStatusSnapshot } from "../status/provider-status";
import { packageVersion } from "../status/package-version";
import { connectionRuntimeStatus } from "../mcp-tools/connect/relay";
import { beginEnrollment, cancelEnrollment, enrollmentIsOpen } from "./enrollment";
import { loadAccountLink } from "../../../bridge/src/account-recovery/link";
import { pendingRuntimeUpdate, runtimeUpdateSettings } from "../../../bridge/src/runtime-updates";
import { UpdateHold } from "../../../bridge/src/runtime-updates/drain/state";
import { chatStatus, serverChat, type CallingChat } from "../status/chat-status";

export const connectionOutput = {
  status: z.enum(["disconnected", "paired", "pairing", "expired", "connected"]),
  computer: z.string(),
  version: z.string(),
  relay: z.string(),
  relayStatus: z.enum(["online", "offline", "unknown"]),
  phoneLastSeenAt: z.number().nullable(),
  phones: z.array(z.object({
    id: z.string().describe("Names this phone to remove_phones; label is its first six characters"),
    label: z.string(),
    name: z.string().describe("The name the phone reported; otherwise \"Phone <label>\", or \"First pairing\" for the "
      + "first pairing, as the phone app names them"),
    primary: z.boolean().describe("The first pairing on this computer"),
    status: z.enum(["paired", "seen"]).describe("seen: an authenticated message from this phone arrived in the last minute"),
    lastSeenAt: z.number().nullable().describe(
      "When this computer last received an authenticated message from this phone key; null: never. A key stays "
        + "paired until someone removes it, so a test install that was deleted keeps its row with an old or null time",
    ),
    addedAt: z.number().nullable().describe("When this computer authorized the key; null when it was added before this was recorded"),
    mostRecent: z.boolean().describe("The phone heard from most recently; remove_phones by notSeenForDays never takes it"),
    stale: z.boolean().describe("Not heard from, and not added, for 30 days, and not mostRecent: what remove_phones with "
      + "notSeenForDays 30 would ask to remove"),
  })).describe("Every phone or iPad key allowed to control this computer: the first pairing, then added devices. "
    + "At most 17; at the limit a new phone takes the place of an added phone not seen for 30 days"),
  expiresAt: z.number().nullable(),
  expiresInMinutes: z.number().int().positive().nullable(),
  providers: z.array(z.object({ id: z.string(), status: z.string(), detail: z.string() })),
  roomPrefix: z.string(),
  accountLinkSaved: z.boolean(),
  runtimeUpdates: z.object({ enabled: z.boolean(), lockedByEnvironment: z.boolean() }),
  pendingUpdate: z.object({
    version: z.string(),
    state: z.enum(["selected", "downloaded"]),
    detail: z.string(),
    hold: UpdateHold.optional().describe("The running monitor's own account of the wait: holding (new phone messages wait "
      + "for blockers until holdUntil), handing-over, waiting (the last hold gave up; nextAttemptAt), or start-check-failed; "
      + "blockers lists what cannot be handed over (runs by chat, approvals, answers being sent), survivingRuns the chats "
      + "that keep going and are taken over by the new version"),
  }).nullable().describe("A newer GrantTap runtime on this computer than the one this server runs, and why it is not running yet"),
  chat: z.object({
    sessionId: z.string().describe("The calling chat's id as its provider names it"),
    provider: z.enum(["claude", "codex", "grok", "cursor"]).nullable(),
    identifiedBy: z.enum(["environment", "transcript", "hook"]).describe(
      "environment: the host named the chat when it started this server (Claude Code, Grok Build); transcript: the Codex "
        + "process that started this server holds only this chat's rollout open; hook: the provider hook that ran inside "
        + "the calling chat recorded this call (Cursor, or a server shared by several chats)"),
    queuedPhoneMessages: z.number().int().nonnegative()
      .describe("Phone messages this computer holds for the calling chat; they arrive one by one after the current turn"),
    autoContinue: z.boolean().describe("Whether the chat continues by itself after a subscription limit stopped it"),
    continuation: z.object({ dueAt: z.number(), early: z.boolean() }).nullable()
      .describe("The continuation queued for the chat after a subscription limit; early: another goes at once"),
  }).nullable().describe("The calling chat, when its host or its provider hook names it; null when neither does"),
  passkeyUrl: z.string().url().optional(),
};

export type PendingCode = {
  attemptId: string;
  room: string;
  expiresAt: number;
  pairingUri: string;
  qrDataUrl: string;
};

/** Ephemeral transfer material never enters logs, structured output, or disk. */
export class ConnectionState {
  private pending: PendingCode | null = null;

  remember(code: Omit<PendingCode, "attemptId"> & { attemptId?: string; peerPublicKey?: string }): void {
    const attempt = beginEnrollment({
      room: code.room,
      peerPublicKey: code.peerPublicKey ?? (isMachineConfigured()
        ? loadConfig(readOnlyMachineConfigPath()).peerPublicKey
        : null),
    });
    this.pending = { ...code, attemptId: code.attemptId ?? attempt.attemptId };
  }

  snapshot(now = Date.now(), caller: CallingChat | undefined = serverChat()) {
    const config = isMachineConfigured() ? loadConfig(readOnlyMachineConfigPath()) : null;
    const runtime = connectionRuntimeStatus(config?.room);
    const phones = listPairedPhones(runtime.phoneLastSeenAt, now);
    const lastSeenAt = phones.reduce<number | null>((latest, phone) =>
      phone.lastSeenAt != null && (latest == null || phone.lastSeenAt > latest)
        ? phone.lastSeenAt : latest, null);
    if (!config || this.pending?.room !== config.room) {
      cancelEnrollment();
      this.pending = null;
    } else if (this.pending && !enrollmentIsOpen(this.pending.attemptId)) this.pending = null;
    const expired = this.pending !== null && this.pending.expiresAt <= now;
    const status = !config ? "disconnected" : this.pending
      ? expired ? "expired" : "pairing"
      : lastSeenAt && now - lastSeenAt < 60_000 ? "connected" : "paired";
    const code = expired ? null : this.pending;
    return {
      structuredContent: {
        status,
        computer: computerDisplayName(),
        version: packageVersion(),
        relay: config ? new URL(config.relayUrl).host : "",
        relayStatus: runtime.relayStatus,
        phoneLastSeenAt: lastSeenAt,
        phones,
        expiresAt: this.pending?.expiresAt ?? null,
        expiresInMinutes: code ? Math.max(1, Math.ceil((code.expiresAt - now) / 60_000)) : null,
        providers: inspectProviderStatusSnapshot().providers.map(({ id, status, detail }) => ({ id, status, detail })),
        roomPrefix: config?.room ? config.room.slice(0, 8) : "",
        accountLinkSaved: loadAccountLink() !== null,
        runtimeUpdates: runtimeUpdateSettings(),
        pendingUpdate: pendingRuntimeUpdate(packageVersion()) ?? null,
        chat: chatStatus(config?.room, caller),
      },
      _meta: { granttap: code ? { pairingUri: code.pairingUri, qrDataUrl: code.qrDataUrl } : {} },
    };
  }
}
