type Call = { toolCallId?: unknown; kind?: unknown; rawInput?: unknown; locations?: unknown };

/** Cursor sends action arguments in tool updates, separately from the permission RPC. */
export class CursorCallContext {
  private readonly calls = new Map<string, Call>();

  remember(raw: unknown, sessionId: string): void {
    if (!sessionId || !raw || typeof raw !== "object") return;
    const value = raw as { sessionId?: unknown; update?: Call & { sessionUpdate?: string; status?: string } };
    const update = value.update;
    if (value.sessionId !== sessionId || !update || !["tool_call", "tool_call_update"].includes(update.sessionUpdate ?? "")) return;
    if (typeof update.toolCallId !== "string" || update.toolCallId.length > 256) return;
    const previous = this.calls.get(update.toolCallId) ?? {};
    const next = { ...previous, ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
      ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
      ...(update.locations !== undefined ? { locations: update.locations } : {}) };
    if (Buffer.byteLength(JSON.stringify(next)) > 65_536) { this.calls.delete(update.toolCallId); return; }
    this.calls.delete(update.toolCallId); this.calls.set(update.toolCallId, next);
    while (this.calls.size > 64) this.calls.delete(this.calls.keys().next().value!);
  }

  permission(raw: unknown, sessionId: string): unknown {
    if (!raw || typeof raw !== "object") return raw;
    const value = raw as { sessionId?: unknown; toolCall?: Call };
    if (value.sessionId !== sessionId || typeof value.toolCall?.toolCallId !== "string") return raw;
    const saved = this.calls.get(value.toolCall.toolCallId);
    if (!saved || saved.kind !== value.toolCall.kind) return raw;
    return { ...value, toolCall: { ...saved, ...value.toolCall,
      rawInput: value.toolCall.rawInput ?? saved.rawInput,
      locations: value.toolCall.locations ?? saved.locations } };
  }
}
