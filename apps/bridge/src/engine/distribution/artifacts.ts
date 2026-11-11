export type EngineArtifact = {
  version: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  sha256: string;
  bytes: number;
};

/** Release hashes are part of the reviewed MCP, never supplied by a remote manifest. */
export const ENGINE_ARTIFACTS: readonly EngineArtifact[] = [
  { version: "0.1.7", platform: "darwin", arch: "arm64",
    sha256: "bf7fcf3d08d78a437da21fcb88057d77840be4b22a0f7388f383059e685a76ef", bytes: 12201856 },
  // The 0.1.2 Intel Mac and Linux x64 builds are no longer published. Without a
  // pin, setup reports Graph as unavailable and the helper does not retry a 404;
  // an Engine already installed and verified on such a computer keeps working.
];

export function selectEngineArtifact(platform: string = process.platform, arch: string = process.arch): EngineArtifact | undefined {
  return ENGINE_ARTIFACTS.find(artifact => artifact.platform === platform && artifact.arch === arch);
}

export function engineArtifactName(artifact: EngineArtifact): string {
  return `granttap-engine-${artifact.platform === "win32" ? "windows" : artifact.platform}-${artifact.arch}${artifact.platform === "win32" ? ".exe" : ""}`;
}

export function validateEngineArtifact(artifact: EngineArtifact): void {
  if (!/^\d+\.\d+\.\d+$/.test(artifact.version)
    || !["darwin", "linux", "win32"].includes(artifact.platform)
    || !["arm64", "x64"].includes(artifact.arch)
    || !/^[a-f\d]{64}$/.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 40 * 1024 * 1024) {
    throw new Error("Engine release metadata is invalid");
  }
}
