import { join } from "node:path";
import { configDir } from "../config";
import { MeshStore } from "./store";

let singleton: MeshStore | undefined;

export function meshStorePath(): string {
  return join(configDir(), "project-mesh.json");
}

export function localMeshStore(): MeshStore {
  singleton ??= new MeshStore(meshStorePath());
  return singleton;
}

export function resetLocalMeshStore(): void {
  singleton = undefined;
}
