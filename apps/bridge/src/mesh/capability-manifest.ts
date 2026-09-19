import { createHash } from "node:crypto";
import type { SharedSkill } from "../../../../packages/protocol/schema";
import { projectSharedSkills } from "../capabilities/skills";

export type CapabilityManifest = {
  desired: SharedSkill[];
  actual: SharedSkill[];
  digest: string;
  matched: boolean;
};

/** Desired is the repo inventory. Actual stays unknown until a host observes it. */
export function capabilityManifest(paths: Array<string | undefined>): CapabilityManifest {
  const desired = projectSharedSkills(paths);
  const actual = desired.map((skill) => ({ ...skill, state: "unknown" as const }));
  const digest = createHash("sha256")
    .update(desired.map((skill) => `${skill.name}:${skill.digest ?? ""}`).sort().join("\n"))
    .digest("hex");
  return { desired, actual, digest, matched: false };
}
