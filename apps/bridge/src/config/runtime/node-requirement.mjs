import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"));
export const minimumNodeVersion = manifest.engines.node.replace(/^>=/, "");

/** Shared by the native launcher and persistent-service installer before loading tsx. */
export function isSupportedNode(version) {
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.replace(/^v/, "").split(".").map(Number);
  const minimum = minimumNodeVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}
