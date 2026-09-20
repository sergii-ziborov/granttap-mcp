export type EngineHealthState =
  | "disabled"
  | "starting"
  | "healthy"
  | "unavailable"
  | "incompatible"
  | "backoff";

export type EngineHealth = {
  state: EngineHealthState;
  checkedAt: number;
  engineVersion?: string;
  reason?: string;
};

export function engineHealth(
  state: EngineHealthState,
  details: Omit<EngineHealth, "state" | "checkedAt"> = {},
  checkedAt = Date.now(),
): EngineHealth {
  return { state, checkedAt, ...details };
}
