/** Budget the complete delivery, preserving coordination and expandable evidence. */
import type { CompactProjectContext } from "./project";
import type { MeshContextPacket } from "./packet";

export function selectCompactContext(base: CompactProjectContext, packet: MeshContextPacket) {
  const { content, included, omitted, ...status } = packet;
  const fallback = { ...base, contextPacket: { ...status,
    expand: base.expand.full } };
  if (!content || !included?.length) return fallback;
  const ids = new Set(included);
  const events = [...base.events, ...base.decisions];
  if (events.some(event => !ids.has(`event.${event.eventId}`))
    || base.knowledge?.some(record => !ids.has(`knowledge.${record.recordId}`))) return fallback;
  const eventRef = (event: CompactProjectContext["events"][number]) => ({
    eventId: event.eventId, eventType: event.eventType,
    sourceSessionId: event.sourceSessionId, contextRef: `event.${event.eventId}`,
  });
  const compiled = { ...base, schema: "granttap.project-context.compiled.v1" as const,
    events: base.events.map(eventRef), decisions: base.decisions.map(eventRef),
    knowledge: base.knowledge?.map(({ content: _content, ...record }) => ({
      ...record, contextRef: `knowledge.${record.recordId}`,
    })), contextPacket: packet };
  // Compare the entire JSON response: citations and transport metadata cost tokens too.
  // A byte guard complements the same deterministic character estimate used in research.
  const size = (value: unknown) => {
    const json = JSON.stringify(value);
    return { characters: json.length, bytes: Buffer.byteLength(json) };
  };
  const before = size(fallback), after = size(compiled);
  return after.characters < before.characters && after.bytes < before.bytes ? compiled : fallback;
}
