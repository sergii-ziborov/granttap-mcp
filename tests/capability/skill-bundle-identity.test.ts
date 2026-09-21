import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skillBundleDigest } from "../../apps/bridge/src/capabilities/skill-bundle";
import {
  projectSharedSkills, projectSkillDefinitionPath, skillDefinitionPath,
} from "../../apps/bridge/src/capabilities/skills";
import { capabilityFingerprint } from "../../apps/bridge/src/policy/capability-fingerprint";

test("a skill script or reference changes the Project digest and action fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-skill-bundle-"));
  const skill = join(root, ".agents", "skills", "release-check");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await mkdir(join(skill, "references"));
  await writeFile(join(skill, "SKILL.md"), "---\nname: release-check\n---\n# Release\n");
  await writeFile(join(skill, "scripts", "verify.sh"), "exit 0\n");
  const first = projectSharedSkills([root])[0]?.digest;
  assert.match(first ?? "", /^[a-f0-9]{64}$/);
  assert.equal(capabilityFingerprint({
    provider: "claude", cwd: root, toolName: "Skill", toolInput: { skill: "release-check" },
  }).script_hash, first);
  assert.equal(capabilityFingerprint({
    provider: "claude", cwd: root, toolName: "Skill", toolInput: { skill: "release-check" },
  }).origin, "project-skill");
  await writeFile(join(skill, "scripts", "verify.sh"), "exit 1\n");
  const changedScript = projectSharedSkills([root])[0]?.digest;
  assert.notEqual(changedScript, first);
  await writeFile(join(skill, "references", "policy.md"), "Never publish from a task.\n");
  assert.notEqual(projectSharedSkills([root])[0]?.digest, changedScript);
  await symlink(join(root, "outside"), join(skill, "scripts", "external"));
  assert.equal(skillBundleDigest(join(skill, "SKILL.md")), undefined);
  assert.equal(projectSharedSkills([root])[0]?.state, "unknown");
});

test("a Project skill takes precedence over a home skill with the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-skill-project-"));
  const home = await mkdtemp(join(tmpdir(), "granttap-skill-home-"));
  const oldHome = process.env.HOME;
  const local = join(root, ".agents", "skills", "release-check", "SKILL.md");
  const global = join(home, ".agents", "skills", "release-check", "SKILL.md");
  await mkdir(join(local, ".."), { recursive: true });
  await mkdir(join(global, ".."), { recursive: true });
  await writeFile(local, "---\nname: release-check\n---\nProject\n");
  await writeFile(global, "---\nname: release-check\n---\nHome\n");
  try {
    process.env.HOME = home;
    assert.equal(skillDefinitionPath("release-check", root), local);
    assert.equal(projectSkillDefinitionPath("release-check", root), local);
    await rm(local);
    assert.equal(skillDefinitionPath("release-check", root), global);
    assert.equal(projectSkillDefinitionPath("release-check", root), undefined);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("two workspace bundles with one skill name report a conflict", async () => {
  const first = await mkdtemp(join(tmpdir(), "granttap-skill-first-"));
  const second = await mkdtemp(join(tmpdir(), "granttap-skill-second-"));
  for (const [root, body] of [[first, "First"], [second, "Second"]] as const) {
    const folder = join(root, ".agents", "skills", "release-check");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: release-check\n---\n${body}\n`);
  }
  const skill = projectSharedSkills([first, second])[0];
  assert.equal(skill?.state, "conflict");
  assert.equal(skill?.digest, undefined);
  assert.equal(skill?.source, "multiple project workspaces");
});

test("a workspace without a Git boundary does not import parent Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-skill-ancestor-"));
  const workspace = join(root, "workspace");
  const parentSkill = join(root, ".agents", "skills", "home-only");
  await mkdir(workspace, { recursive: true });
  await mkdir(parentSkill, { recursive: true });
  await writeFile(join(parentSkill, "SKILL.md"), "---\nname: home-only\n---\nParent\n");
  assert.deepEqual(projectSharedSkills([workspace]), []);
});

test("a linked Project skill catalog does not import another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-skill-linked-"));
  const outside = await mkdtemp(join(tmpdir(), "granttap-skill-outside-"));
  const foreign = join(outside, "skills", "foreign");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "SKILL.md"), "---\nname: foreign\n---\nOutside\n");
  await symlink(outside, join(root, ".agents"));
  assert.deepEqual(projectSharedSkills([root]), []);
});
