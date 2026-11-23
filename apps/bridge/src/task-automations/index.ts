/** GrantTap's own automations: a message sent into a chat on a schedule, run by the persistent monitor. */
export { handleTaskAutomations } from './controls/relay';
export { startTaskAutomations, AUTOMATION_PASS_MS } from './runner/monitor';
export { AUTOMATION_MESSAGE_PREFIX } from './runner';
