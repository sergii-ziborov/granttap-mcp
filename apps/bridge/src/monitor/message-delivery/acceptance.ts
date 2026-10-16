/**
 * When a message from the phone counts as delivered.
 *
 * Delivery used to mean "the agent finished its whole turn within ten
 * minutes": a longer turn was killed at the deadline and the person's bubble
 * turned "Not delivered" although the agent had taken the message and was
 * working on it. Delivered now means the agent took it. A run that fails at
 * once (paused, transferred, a CLI that will not start) is still that
 * failure; a run that is still going after a short window is delivered, and
 * its answer — or the reason it stopped — reaches the chat when it ends.
 */

/** Long enough for a provider CLI to refuse at once, short enough not to keep the phone waiting. */
export const ACCEPTANCE_WINDOW_MS = 15_000;

/** A safety bound for an unattended turn; the person stops a run with Stop, not with a deadline. */
export const PHONE_RUN_LIMIT_MS = 6 * 60 * 60_000;

export async function acceptWhenStarted<T>(
  run: Promise<T>,
  finish: (result: T) => Promise<unknown>,
  windowMs = ACCEPTANCE_WINDOW_MS,
): Promise<T | "started"> {
  let timer: NodeJS.Timeout | undefined;
  const started = new Promise<"started">((resolve) => {
    timer = setTimeout(() => resolve("started"), windowMs);
  });
  const first = await Promise.race([run, started]);
  clearTimeout(timer);
  if (first !== "started") return first;
  void run.then(finish).catch(() => {});
  return "started";
}
