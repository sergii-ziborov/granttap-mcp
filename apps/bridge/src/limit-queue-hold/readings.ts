import type { ProviderAccountUsage } from '../../../../packages/protocol/schema';
import { LIFT_BELOW_PERCENT, LIFT_READING_MAX_AGE_MS, limitLifted } from '../limit-continuation';
import type { ChatLimit } from './decision';

/**
 * Whether the account's readings show room for a chat its limit refused: a reading taken after `since` and
 * less than ten minutes old. A Claude limit that names its window is read from that window, as its
 * continuation is (`limitLifted`); any other from the agent's own account reading, every window of which must
 * be below 98 %. A signed-out account, or no reading, shows no room.
 */
export function readingsShowRoom(agent: string, limit: ChatLimit, since: number, usage: ProviderAccountUsage[],
  now: number): boolean {
  if (agent === 'claude' && limit.resetsAt !== undefined && limit.window) {
    return limitLifted({ resetsAt: limit.resetsAt, window: limit.window }, since, usage, now);
  }
  const account = usage.find(report => report.provider === agent && report.limitId === agent && !report.label);
  if (!account?.windows.length || account.observedAt <= since || now - account.observedAt > LIFT_READING_MAX_AGE_MS) return false;
  return account.windows.every(window => window.usedPercent < LIFT_BELOW_PERCENT);
}
