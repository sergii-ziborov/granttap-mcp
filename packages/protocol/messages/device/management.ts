import { z } from 'zod';
import { CodingAgent } from '../primitives';

const identifier = z.string().trim().min(1).max(160);
export const DeviceManagementAction = z.enum([
  'status', 'clear-cache', 'runtime-update', 'runtime-install', 'runtime-restart',
  'provider-login', 'provider-login-code', 'provider-login-cancel', 'provider-restart',
]);
export const DeviceManagementRequest = z.object({
  type: z.literal('device.manage'),
  requestId: identifier,
  computerId: identifier.optional(),
  action: DeviceManagementAction,
  agent: CodingAgent.optional(),
  operationId: identifier.optional(),
  interruptActiveTasks: z.boolean().optional(),
  // An authorization code is ephemeral input to the native CLI, never a chat message.
  code: z.string().min(1).max(4_096).optional(),
  createdAt: z.number().finite(),
}).strict().superRefine((value, ctx) => {
  if (value.action !== 'status' && !value.computerId) {
    ctx.addIssue({ code: 'custom', path: ['computerId'], message: 'A mutation requires the observed computer identity' });
  }
  if (value.action.startsWith('provider-') && !value.agent) {
    ctx.addIssue({ code: 'custom', path: ['agent'], message: 'Provider actions require a provider' });
  }
  if (value.action === 'provider-login-code' && (!value.operationId || !value.code)) {
    ctx.addIssue({ code: 'custom', path: ['operationId'], message: 'The pending native login owns the code' });
  }
  if (value.code != null && value.action !== 'provider-login-code') {
    ctx.addIssue({ code: 'custom', path: ['code'], message: 'Codes are accepted only by the pending login' });
  }
});
export type DeviceManagementRequest = z.infer<typeof DeviceManagementRequest>;

export const DeviceCacheCategory = z.object({
  id: identifier, name: z.string().min(1).max(100),
  bytes: z.number().int().nonnegative(), reclaimableBytes: z.number().int().nonnegative(),
});
export const DeviceProviderState = z.object({
  agent: CodingAgent, installed: z.boolean(), version: z.string().max(80).optional(),
  authentication: z.enum(['signed-in', 'signed-out', 'unknown', 'not-installed']),
  loginSupported: z.boolean(), restartSupported: z.boolean(),
  activeRequests: z.number().int().nonnegative(),
});
export const DeviceManagementSnapshot = z.object({
  computerId: identifier, computerName: z.string().min(1).max(200), observedAt: z.number().finite(),
  runtimeVersion: z.string().min(1).max(80), selectedRuntimeVersion: z.string().max(80).optional(),
  runtimeEpoch: identifier,
  availableRuntimeVersion: z.string().max(80).optional(),
  automaticUpdatesEnabled: z.boolean(), runtimeUpdateSupported: z.boolean(), runtimeRestartSupported: z.boolean(),
  cache: z.array(DeviceCacheCategory).max(12), providers: z.array(DeviceProviderState).max(4),
});
export type DeviceManagementSnapshot = z.infer<typeof DeviceManagementSnapshot>;

export const ProviderLoginProgress = z.object({
  operationId: identifier, agent: CodingAgent,
  phase: z.enum(['starting', 'awaiting-browser', 'awaiting-code', 'signed-in', 'failed', 'cancelled', 'expired']),
  verificationURL: z.string().url().max(8_192).optional(),
  userCode: z.string().max(128).optional(),
  expiresAt: z.number().finite(),
  message: z.string().max(512),
});
export type ProviderLoginProgress = z.infer<typeof ProviderLoginProgress>;

export const DeviceManagementResult = z.object({
  type: z.literal('device.manage.result'), requestId: identifier, computerId: identifier,
  action: DeviceManagementAction, agent: CodingAgent.optional(),
  phase: z.enum(['running', 'completed', 'failed', 'waiting']),
  message: z.string().max(512), createdAt: z.number().finite(),
  snapshot: DeviceManagementSnapshot.optional(), login: ProviderLoginProgress.optional(),
});
export type DeviceManagementResult = z.infer<typeof DeviceManagementResult>;
