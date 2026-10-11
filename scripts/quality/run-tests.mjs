#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const concurrency = Number(process.env.GRANTTAP_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("GRANTTAP_TEST_CONCURRENCY must be an integer from 1 to 4");
}
const allFiles = [...testFiles("tests"), ...testFiles("apps")].sort();
const requested = process.argv.slice(2);
if (requested.some((file) => !allFiles.includes(file))) {
  throw new Error("Requested test file is outside the repository test inventory");
}
const files = requested.length ? [...new Set(requested)].sort() : allFiles;
if (files.length === 0) throw new Error("No test files found");
// Keep test workers bounded when Apple simulators share the development host.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
