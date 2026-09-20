#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";
import { runRestrictionsCheck } from "../../mesh/restrictions";

const result = runRestrictionsCheck(resolve(process.argv[2] ?? process.cwd()));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
