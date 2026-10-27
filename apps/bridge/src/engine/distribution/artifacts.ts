export type EngineArtifact = {
  version: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  sha256: string;
  bytes: number;
};

/** Release hashes are part of the reviewed MCP, never supplied by a remote manifest. */
export const ENGINE_ARTIFACTS: readonly EngineArtifact[] = [
  { version: "0.1.5", platform: "darwin", arch: "arm64",
    sha256: "bd16babf11fd3d7e65b9713797b977deba1670ba41230a0e6607ce938b847455", bytes: 12202080 },
  { version: "0.1.2", platform: "darwin", arch: "x64",
    sha256: "b3235a15936a77ec323d5ecbc54a0bc19994fe6e5a36044da964b68524b4c1dd", bytes: 13944984 },
  { version: "0.1.2", platform: "linux", arch: "x64",
    sha256: "1a6b227289b69459a64cd13078044960cf83bb858e6be1b70b1b38c950b00cc0", bytes: 14753312 },
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
