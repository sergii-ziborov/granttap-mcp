export type EngineArtifact = {
  version: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  sha256: string;
  bytes: number;
};

/** Release hashes are part of the reviewed MCP, never supplied by a remote manifest. */
export const ENGINE_ARTIFACTS: readonly EngineArtifact[] = [
  { version: "0.1.1", platform: "darwin", arch: "arm64",
    sha256: "3381b757cf79470267976c3e74f8262c9a9a754bcff3b45f74d6f2b00d74e1e4", bytes: 12067440 },
  { version: "0.1.1", platform: "darwin", arch: "x64",
    sha256: "c08752079cd58b9249c345e81cef02130da553ac7066494323a41e2204d581a8", bytes: 13915384 },
  { version: "0.1.1", platform: "linux", arch: "x64",
    sha256: "e2d322857be5a628795ffa088bd873dbffb42697a77e79b9d98b80a290d574b2", bytes: 14726408 },
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
