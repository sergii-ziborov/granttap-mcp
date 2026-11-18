import { z } from "zod";
import { AgentId } from "../primitives";

/**
 * The ten places a coding agent's work goes, after lot-map by Aleksei Volodin (MIT,
 * https://github.com/alexeyw/lot-map). `web` is the map's Network station.
 */
export const LIVE_MAP_STATIONS = ["you", "model", "memory", "files", "shell", "web", "browser", "agents",
  "skills", "hooks"] as const;
export const LiveMapStation = z.enum(LIVE_MAP_STATIONS);
export type LiveMapStation = z.infer<typeof LiveMapStation>;

/** At most this many pulses travel in one frame; the rest are counted in `dropped`. */
export const MAX_PULSES_PER_FRAME = 48;
/** A frame larger than this is cut down to its newest pulses before it is sealed. */
export const MAX_PULSE_FRAME_BYTES = 12_000;

const count = z.number().int().nonnegative().max(1_000_000);
const opaque = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));
/** A tool, skill or agent type name, or a model id: a name, never arguments or content. */
export const PULSE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .:_\-/()[\]·]{0,63}$/u;

/**
 * One thing the agent did, by name only. `start` and `end` share an `id`; `done` is a call that
 * started and ended between two frames. `mark` is a moment that is not a tool call: a message from
 * the person, the answer, a model step or change, a compaction, or an approval the hook asked for.
 */
export const SessionPulse = z.object({
  id: opaque(12),
  station: LiveMapStation,
  name: z.string().regex(PULSE_NAME),
  phase: z.enum(["start", "end", "done"]),
  status: z.enum(["run", "ok", "error", "blocked"]),
  at: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().max(6 * 3_600_000).optional(),
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId: opaque(8).optional(),
  /** How many calls run at this station at once, when more than one. */
  parallel: z.number().int().min(2).max(99).optional(),
  mark: z.enum(["message", "answer", "step", "model", "compact", "approval"]).optional(),
  /** The model a `model` mark changed to. */
  model: z.string().regex(PULSE_NAME).optional(),
}).strict();
export type SessionPulse = z.infer<typeof SessionPulse>;

/** How many calls each station had in the computer's window of the chat: the map's worn spokes. */
export const LiveMapCounts = z.object(Object.fromEntries(LIVE_MAP_STATIONS.map(station =>
  [station, count.optional()])) as Record<LiveMapStation, z.ZodOptional<typeof count>>).strict();
export type LiveMapCounts = z.infer<typeof LiveMapCounts>;

/**
 * A batch of a chat's pulses, sent at most once a second and only while a phone keeps
 * `session.pulses.subscribe` renewed. It travels as a replaceable snapshot under the chat's own key:
 * it never waits in the relay's mailbox and never goes ahead of an answer. `running` names every call
 * still at work, so a phone that missed a frame ends what is no longer running.
 */
export const SessionPulses = z.object({
  type: z.literal("session.pulses"),
  sessionId: z.string().min(1).max(256),
  agent: AgentId,
  seq: z.number().int().nonnegative(),
  /** The first frame of a subscription: recent pulses to draw from, not news to animate. */
  replay: z.boolean().optional(),
  pulses: z.array(SessionPulse).max(MAX_PULSES_PER_FRAME),
  dropped: count.optional(),
  running: z.array(opaque(12)).max(32),
  counts: LiveMapCounts,
  agents: z.array(opaque(8)).max(12).optional(),
  model: z.string().regex(PULSE_NAME).optional(),
  /** Only where the provider reports the window: a Claude transcript does not. */
  contextPercent: z.number().int().min(0).max(100).optional(),
  contextTokens: z.number().int().nonnegative().max(100_000_000).optional(),
  generatedAt: z.number(),
}).strict();
export type SessionPulses = z.infer<typeof SessionPulses>;

/** The phone has the chat's live map open; it renews this every few seconds while it stays open. */
export const SessionPulsesSubscription = z.object({
  type: z.literal("session.pulses.subscribe"),
  sessionId: z.string().min(1).max(256),
  active: z.boolean(),
  createdAt: z.number(),
}).strict();
export type SessionPulsesSubscription = z.infer<typeof SessionPulsesSubscription>;
