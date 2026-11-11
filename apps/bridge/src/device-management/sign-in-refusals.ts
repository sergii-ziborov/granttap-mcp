import type { CodingAgent } from '../../../../packages/protocol/schema';

/**
 * `claude auth status` keeps reporting a login whose token can no longer be
 * renewed, so Devices said "Signed in" while every phone message was refused.
 * A run refused for sign-in outranks that status until the provider signs in
 * again or completes a run.
 */
const refused = new Set<CodingAgent>();

export const providerSignIns = {
  refused(agent: CodingAgent | undefined): void { if (agent) refused.add(agent); },
  accepted(agent: CodingAgent | undefined): void { if (agent) refused.delete(agent); },
  wasRefused(agent: CodingAgent): boolean { return refused.has(agent); },
};
