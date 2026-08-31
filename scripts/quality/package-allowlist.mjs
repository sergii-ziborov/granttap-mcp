#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PUBLIC_FILES = new Set([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
]);
const PUBLIC_PREFIXES = ["apps/", "bin/", "cursor-plugin/", "packages/"];
const PUBLIC_DOCS = /^(?:docs\/cursor-authorize\.md|docs\/images\/[^/]+)$/;
const INTERNAL_SEGMENT = /(?:^|\/)(?:tests?|scripts?|superpowers|plans?|roadmaps?|audits?|research)(?:\/|$)/i;
const INTERNAL_GUIDE = /(?:^|\/)(?:AGENTS|CODEX|CLAUDE)\.md$/i;
const TEST_EVIDENCE = /(?:^|\/)(?:coverage|test[-_ ]?evidence|test[-_ ]?results?)(?:\/|$)/i;

export function rejectedPackageEntries(entries) {
  return entries.filter((path) => {
    if (INTERNAL_SEGMENT.test(path) || INTERNAL_GUIDE.test(path) || TEST_EVIDENCE.test(path)) {
      return true;
    }
    return !PUBLIC_FILES.has(path)
      && !PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))
      && !PUBLIC_DOCS.test(path);
  });
}

export function dryRunPackageEntries() {
  const raw = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const report = JSON.parse(raw);
  if (!Array.isArray(report) || !Array.isArray(report[0]?.files)) {
    throw new Error("npm pack did not return a file manifest");
  }
  return report[0].files.map((entry) => String(entry.path));
}

export function verifyPackageAllowlist(entries = dryRunPackageEntries()) {
  const rejected = rejectedPackageEntries(entries);
  if (rejected.length > 0) {
    throw new Error(`package contains non-public files:\n${rejected.join("\n")}`);
  }
  return entries.length;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const count = verifyPackageAllowlist();
    console.log(`Package allowlist: accepted ${count} files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
