/**
 * Show a helper run where it belongs: under the chat that started it.
 *
 * A run is the chat's work, like one of its agents, so it is published as one
 * of the chat's nested conversations and never as a chat of its own. A run
 * whose parent was not captured, or whose parent is no longer on this
 * computer, is published nowhere; the provider's own history still has it.
 */
import type { ActivityEntry, ChildThreadInfo, SessionInfo } from "../../../../packages/protocol/schema";
import { boundChildThreads, childEntryFields, childTitle } from "../sessions/support/child-threads";
import { helperRunLink, type HelperRunLink } from "./links";
import { helperRunImageId, helperRunPictures, type RunPicture } from "./pictures/store";

/** A provider session a scanner recognised as a helper run and kept out of its chats. */
export type HelperRunSession = {
  session: SessionInfo;
  kind: string;
  /** What a phone that does not know the kind calls the run. */
  label: string;
  folder: string;
};

function sessionKey(agent: string, sessionId: string): string {
  return `${agent}\0${sessionId}`;
}

/** The runs attached by the newest catalog, so a run's conversation can be read when a phone opens it. */
let attached = new Map<string, { session: SessionInfo; folder: string }>();

type MessageImage = NonNullable<ActivityEntry["images"]>[number];

/** The `/var` and `/private/var` spellings of a macOS temp path name one folder. */
function samePath(text: string): string {
  return text.replace(/\\/g, "/").replace(/^\/private\/(var|tmp)\//, "/$1/");
}

/**
 * A kept picture as a phone shows it. When a line of the message is the path
 * the run wrote the picture to, the picture takes that line's place.
 */
function pictureImage(folder: string, picture: RunPicture, text = ""): MessageImage {
  const id = helperRunImageId(folder, picture.hash);
  const line = text.split("\n").map((item) => item.trim().replace(/^(?:[-*+] |\d+\. )/, ""))
    .find((item) => samePath(item.replace(/^`(.*)`$/, "$1")) === samePath(picture.source));
  return { id, name: picture.name, markdown: line && line.length <= 2_400 ? line : `![${picture.name}](granttap-image:${id})` };
}

function childOf(parent: SessionInfo, run: HelperRunSession): ChildThreadInfo {
  const { session } = run;
  const images = helperRunPictures(run.folder).map((picture) => pictureImage(run.folder, picture));
  return {
    threadId: session.sessionId,
    parentThreadId: parent.sessionId,
    title: childTitle(session.title),
    agentName: run.label,
    kind: run.kind,
    depth: 1,
    state: session.state,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    tokensSession: session.tokensSession,
    tokensLastTurn: session.tokensLastTurn,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Add each run to its parent's nested conversations. The parent's own state,
 * clock and spend stay its own: the run is another provider's work.
 */
export function attachHelperRuns(
  sessions: SessionInfo[],
  runs: readonly HelperRunSession[],
  link: (folder: string) => HelperRunLink | undefined = helperRunLink,
): SessionInfo[] {
  const parents = new Map(sessions.map((session) => [sessionKey(session.agent, session.sessionId), session]));
  const children = new Map<string, ChildThreadInfo[]>();
  const read = new Map<string, { session: SessionInfo; folder: string }>();
  for (const run of runs) {
    const known = link(run.folder);
    const key = known ? sessionKey(known.parentAgent, known.parentSessionId) : undefined;
    const parent = key ? parents.get(key) : undefined;
    if (!key || !parent) continue;
    children.set(key, [...(children.get(key) ?? []), childOf(parent, run)]);
    read.set(run.session.sessionId, { session: run.session, folder: run.folder });
  }
  attached = read;
  if (children.size === 0) return sessions;
  return sessions.map((session) => {
    const own = children.get(sessionKey(session.agent, session.sessionId));
    return own ? { ...session, childThreads: boundChildThreads([...(session.childThreads ?? []), ...own]) } : session;
  });
}

/** The helper run behind one of a chat's nested conversations, when that conversation is one. */
export function helperRunThread(
  parent: SessionInfo,
  threadId: string,
): { child: ChildThreadInfo; session: SessionInfo; folder?: string } | undefined {
  const child = parent.childThreads?.find((item) => item.threadId === threadId && item.kind);
  if (!child) return undefined;
  const known = attached.get(threadId);
  if (known) return { child, ...known };
  const session: SessionInfo = {
    sessionId: threadId, agent: "grok", state: child.state, startedAt: child.startedAt,
    lastActivityAt: child.lastActivityAt, tokensSession: child.tokensSession, tokensLastTurn: child.tokensLastTurn,
  };
  return { child, session };
}

/**
 * A run's own messages, marked as the nested conversation they are shown in.
 * The pictures kept from the run are shown on its last answer.
 */
export function helperRunEntries(child: ChildThreadInfo, entries: readonly ActivityEntry[],
  folder?: string): ActivityEntry[] {
  const marked = entries.map((entry) => ({ ...entry, ...childEntryFields(child) }));
  const pictures = helperRunPictures(folder);
  if (!folder || pictures.length === 0) return marked;
  const lastOf = (kind: ActivityEntry["kind"]) => marked.map((entry) => entry.kind).lastIndexOf(kind);
  const at = lastOf("final") >= 0 ? lastOf("final") : lastOf("message");
  if (at < 0) return marked;
  const answer = marked[at]!;
  const images = pictures.map((picture) => pictureImage(folder, picture, answer.text));
  return marked.map((entry, index) => index === at ? { ...entry, images: [...(entry.images ?? []), ...images].slice(0, 32) } : entry);
}
