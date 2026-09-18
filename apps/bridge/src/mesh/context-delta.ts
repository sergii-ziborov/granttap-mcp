import type { CompactContextEvent, CompactProjectContext } from "./project-context";
import { renderCompactProjectContext } from "./project-context";
import type { ScopedMeshView } from "./scoped-view";

export type ContextCursor = { lastEventId?: string };

export type ContextDelta =
  | { mode: "delta"; after: string; events: CompactContextEvent[] }
  | (CompactProjectContext & { reason: "unknown_cursor" | "missing_cursor" });

/** Cursor-based compact view. An unknown cursor is a full compact reset, not a guess. */
export function renderContextDelta(view: ScopedMeshView, cursor?: ContextCursor): ContextDelta {
  const compact = renderCompactProjectContext(view);
  const lastEventId = cursor?.lastEventId?.trim();
  if (!lastEventId) return { ...compact, reason: "missing_cursor" };
  const index = compact.events.findIndex((event) => event.eventId === lastEventId);
  if (index < 0) return { ...compact, reason: "unknown_cursor" };
  return { mode: "delta", after: lastEventId, events: compact.events.slice(index + 1) };
}
