/** Chats started by another chat: captured from their process, matched from transcripts, published as `startedBy`. */
export { headlessRun, headlessTargets, lineageAgent, lineageText, promptLead, SESSION_ID, type LineageAgent, type PromptLead } from "./headless";
export { createClaudeLineageCalls, createCodexLineageCalls, type LineageCall, type LineageCalls, type LineageFact } from "./facts";
export { attachStartedBy, startedByParents, transcriptParent, TRANSCRIPT_MATCH_MS } from "./attach";
export { captureStartedRuns, startedRunProcesses } from "./capture";
export { folderParents } from "./folders";
export { watchHeadlessRuns, type HeadlessRunWatch } from "./live";
export { startedByKey, startedByLink, startedChildLinks, startedChildSessionIds, type StartedBy, type StartedByLink } from "./links";
export { childrenLast, inheritsParentMesh, parentPlacement, startedChildrenProjects, type MeshPlacement } from "./mesh";
