export type PublishSnapshot = (forceHistory?: boolean) => Promise<void>;
type PublishRun = (forceHistory: boolean) => Promise<void>;

/**
 * Keep expensive catalog scans single-flight.
 *
 * Every phone message used to fire its own `publish()`, so a busy chat could
 * launch several full provider scans at once. Overlapping runs reuse the active
 * one; an explicit history refresh is never dropped and runs once after it.
 */
export function singleFlightPublisher(run: PublishRun): PublishSnapshot {
  let active: Promise<void> | undefined;
  let forceQueued = false;

  return (forceHistory = false): Promise<void> => {
    if (active) {
      forceQueued ||= forceHistory;
      return active;
    }
    active = (async () => {
      let forceNext = forceHistory;
      do {
        forceQueued = false;
        await run(forceNext);
        forceNext = forceQueued;
      } while (forceNext);
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
