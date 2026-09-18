import { createHash } from "node:crypto";
import type { SharedSkill } from "../../../../packages/protocol/schema";
import { projectSharedSkills } from "../capabilities/skills";

export type CapabilityManifest = {
  desired: SharedSkill[];
  actual: SharedSkill[];
  digest: string;
  matched: boolean;
};

/** Desired and actual are the same inventory until a rollout writes a receipt. */
export function capabilityManifest(paths: Array<string | undefined>): CapabilityManifest {
  const desired = projectSharedSkills(paths);
  const actual = desired.map((skill) => ({ ...skill, state: skill.state ?? "installed" }));
  const digest = createHash("sha256")
    .update(desired.map((skill) => `${skill.name}:${skill.digest ?? ""}`).sort().join("\n"))
    .digest("hex");
  return { desired, actual, digest, matched: true };
}
