import { join } from 'node:path';
import { configDir } from '../../config';
import { automaticUpdateSettings, saveAutomaticUpdateSetting } from './storage.mjs';

export function runtimeUpdateSettings() {
  return automaticUpdateSettings(join(configDir(), 'runtime-updates'));
}

/** A running monitor reads this preference before its next check and before activation. */
export function setRuntimeAutoUpdate(enabled: boolean): void {
  saveAutomaticUpdateSetting(join(configDir(), 'runtime-updates'), enabled);
}
