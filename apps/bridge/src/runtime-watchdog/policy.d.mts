export const STALL_MS: number;
export const CHECK_MS: number;
export const RESTART_LIMIT: number;
export const RESTART_WINDOW_MS: number;
export function nextStep(input: { now: number; lastCheck: number; beat: number; graceUntil: number; reported: boolean;
  stallMs?: number; checkMs?: number }): { graceUntil: number; stalled: boolean; recovered: boolean };
export function spendRestart(directory: string, now: number, limit?: number, windowMs?: number):
  { restart: boolean; restartsInWindow: number };
export function faultReport(input: { id: string; kind: string; at: number; stalledMs: number; action: string;
  restartsInWindow: number; version: string }): Record<string, unknown>;
export function rememberFault(directory: string, report: Record<string, unknown>): void;
export function sendPendingFaults(directory: string, url: string, request?: typeof fetch): Promise<number>;
