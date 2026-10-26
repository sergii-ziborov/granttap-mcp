import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Missing preferences preserve the installed default; unreadable settings pause updates. */
export function automaticUpdateSettings(directory) {
  const lockedByEnvironment = process.env.GRANTTAP_DISABLE_AUTO_UPDATE === '1';
  let enabled;
  try {
    const value = JSON.parse(readFileSync(join(directory, 'preferences.json'), 'utf8'));
    enabled = value?.automaticUpdatesEnabled === true;
  } catch (error) { enabled = error?.code === 'ENOENT'; }
  return { enabled: enabled && !lockedByEnvironment, lockedByEnvironment };
}

export function automaticUpdatesAllowed(directory) {
  return automaticUpdateSettings(directory).enabled;
}

/** Separate from selected versions, pairing, credentials, and capability policy. */
export function saveAutomaticUpdateSetting(directory, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Automatic updates require a boolean setting');
  if (enabled && process.env.GRANTTAP_DISABLE_AUTO_UPDATE === '1') {
    throw new Error('Automatic updates are disabled by service configuration');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'preferences.json');
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ automaticUpdatesEnabled: enabled }) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
