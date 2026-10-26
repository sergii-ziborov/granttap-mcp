export type AutomaticUpdateSettings = { enabled: boolean; lockedByEnvironment: boolean };
export function automaticUpdateSettings(directory: string): AutomaticUpdateSettings;
export function automaticUpdatesAllowed(directory: string): boolean;
export function saveAutomaticUpdateSetting(directory: string, enabled: boolean): void;
