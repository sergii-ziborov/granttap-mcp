export function publicRuntimePath(path: string): boolean;
export function submissionManifest(source: Record<string, unknown>): Record<string, unknown>;
export function assemblePlugin(options: {
  output: string;
  runtimeRoot: string;
  root?: string;
}): {
  name: string;
  pluginVersion: string;
  runtimeVersion: string;
  output: string;
};
