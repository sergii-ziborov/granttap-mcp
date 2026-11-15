import type { ProviderAccountUsage } from '../../../../packages/protocol/schema';
import { isSignedOutUsage } from '../provider-account-status/native-usage/memory';

type UsageWindow = ProviderAccountUsage['windows'][number];

/** A reading older than this says nothing about the window now. */
export const LIFT_READING_MAX_AGE_MS = 600_000;
/** Readings lag and round, so a window just under full is still treated as full. */
export const LIFT_BELOW_PERCENT = 98;
/** Two reports of one window's end differ by rounding; a window that rolled over ends hours apart. */
const SAME_WINDOW_MS = 300_000;
const MODEL_PREFIX = 'claude:model:';
/** A weekly limit named after one model, such as `seven_day_opus`. */
const MODEL_WEEKLY = /^seven_day_([a-z0-9]+)$/;
/** Weekly limits that are not one model's; no reading shows them. */
const NOT_A_MODEL = new Set(['overage']);

/** The one reading that covers the model a weekly limit names, when exactly one does. */
function modelReading(model: string, claude: ProviderAccountUsage[]): ProviderAccountUsage | undefined {
  const matches = claude.filter(report => {
    const slug = report.limitId.startsWith(MODEL_PREFIX) ? report.limitId.slice(MODEL_PREFIX.length) : '';
    return slug === model || slug.startsWith(`${model}-`);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** The reading of the window that refused the chat; none for a refusal no reading covers. */
function refusingWindow(rateLimitType: string | undefined, claude: ProviderAccountUsage[])
  : { report: ProviderAccountUsage; window: UsageWindow } | undefined {
  const account = claude.find(report => report.limitId === 'claude' && !report.label);
  const model = MODEL_WEEKLY.exec(rateLimitType ?? '')?.[1];
  const [report, id] = rateLimitType === 'five_hour' ? [account, 'primary']
    : rateLimitType === 'seven_day' ? [account, 'secondary']
      : model && !NOT_A_MODEL.has(model) ? [modelReading(model, claude), 'secondary'] : [undefined, undefined];
  const window = report?.windows.find(row => row.id === id);
  return report && window ? { report, window } : undefined;
}

/**
 * Whether the subscription window that refused a chat has room again before its stated reset: a reading
 * of that same window, taken after the continuation was queued and recently, shows it below full or
 * already rolled over to a window that ends sooner. A refusal by a window no reading covers, or no
 * signed-in reading at all, is never lifted early.
 */
export function limitLifted(limit: { resetsAt: number; window?: string }, scheduledAt: number,
  usage: ProviderAccountUsage[], now: number): boolean {
  const claude = usage.filter(report => report.provider === 'claude');
  if (claude.some(isSignedOutUsage)) return false;
  const found = refusingWindow(limit.window, claude);
  if (!found || found.report.observedAt <= scheduledAt || now - found.report.observedAt > LIFT_READING_MAX_AGE_MS) return false;
  return found.window.usedPercent < LIFT_BELOW_PERCENT || found.window.resetsAt < limit.resetsAt - SAME_WINDOW_MS;
}
