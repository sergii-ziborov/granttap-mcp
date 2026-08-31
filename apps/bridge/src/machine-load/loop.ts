import type { SessionsStatus } from "../../../../packages/protocol/schema";

function configuredInterval(name: string, fallback: number): number {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.trunc(configured)
    : fallback;
}

export const ACTIVE_LOAD_INTERVAL_MS = configuredInterval(
  "GRANTTAP_MONITOR_LOAD_ACTIVE_MS",
  5_000,
);
export const IDLE_LOAD_INTERVAL_MS = configuredInterval(
  "GRANTTAP_MONITOR_LOAD_IDLE_MS",
  30_000,
);
export const RECENT_ACTION_WINDOW_MS = 30_000;

export type RuntimeActivityState = {
  activeExecutions: number;
  lastToolAt?: number;
  phoneForeground?: boolean;
};

export function machineLoadInterval(
  activity: RuntimeActivityState,
  now = Date.now(),
): number {
  const recentAction = activity.lastToolAt != null
    && activity.lastToolAt >= now - RECENT_ACTION_WINDOW_MS;
  return activity.activeExecutions > 0 || recentAction || activity.phoneForeground
    ? ACTIVE_LOAD_INTERVAL_MS
    : IDLE_LOAD_INTERVAL_MS;
}

export function runtimeActivity(
  status: SessionsStatus,
  previous: RuntimeActivityState = { activeExecutions: 0 },
): RuntimeActivityState {
  const activeExecutions = status.sessions.reduce((count, session) => (
    count
      + (session.state === "working" ? 1 : 0)
      + (session.childThreads?.filter((child) => child.state === "working").length ?? 0)
  ), 0);
  return { ...previous, activeExecutions };
}

type Timer = NodeJS.Timeout;

export type MachineLoadLoop = {
  updateStatus: (status: SessionsStatus) => void;
  updateActivity: (activity: Partial<RuntimeActivityState>) => void;
  sampleNow: () => void;
  stop: () => void;
};

export type MachineLoadLoopOptions = {
  connected: () => boolean;
  publish: (status: SessionsStatus, intervalMs: number) => Promise<unknown>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
  onError?: (error: unknown) => void;
};

/** Sample cached status independently from expensive provider discovery. */
export function startMachineLoadLoop(options: MachineLoadLoopOptions): MachineLoadLoop {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let status: SessionsStatus | undefined;
  let activity: RuntimeActivityState = { activeExecutions: 0 };
  let timer: Timer | undefined;
  let running = false;
  let replay = false;
  let stopped = false;

  const clearScheduled = (): void => {
    if (timer) cancel(timer);
    timer = undefined;
  };

  const cadence = (): number => machineLoadInterval(activity, now());

  const scheduleNext = (): void => {
    if (stopped || !status) return;
    clearScheduled();
    timer = schedule(() => {
      timer = undefined;
      void run();
    }, cadence());
  };

  const run = async (): Promise<void> => {
    if (stopped || !status) return;
    if (running) {
      replay = true;
      return;
    }
    clearScheduled();
    running = true;
    try {
      if (options.connected()) await options.publish(status, cadence());
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (stopped) return;
      if (replay) {
        replay = false;
        void run();
      } else {
        scheduleNext();
      }
    }
  };

  const sampleNow = (): void => {
    if (stopped || !status) return;
    clearScheduled();
    void run();
  };

  return {
    updateStatus(nextStatus) {
      const first = status == null;
      const activeBefore = activity.activeExecutions;
      status = nextStatus;
      activity = runtimeActivity(nextStatus, activity);
      if (first || activeBefore !== activity.activeExecutions) sampleNow();
      else if (!running && !timer) scheduleNext();
    },
    updateActivity(update) {
      const before = cadence();
      const lastToolChanged = update.lastToolAt !== undefined
        && update.lastToolAt !== activity.lastToolAt;
      activity = { ...activity, ...update };
      if (lastToolChanged || cadence() !== before) sampleNow();
    },
    sampleNow,
    stop() {
      stopped = true;
      replay = false;
      clearScheduled();
      status = undefined;
    },
  };
}
