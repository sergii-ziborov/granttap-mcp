#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const maxLines = Number(process.env.GRANTTAP_MAX_SOURCE_LINES ?? 300);
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".swift", ".sh", ".rb"]);
const skippedDirectories = new Set([".git", "node_modules", "coverage", "dist", "build"]);
const root = process.cwd();
const violations = [];

walk(root);
if (violations.length === 0) {
  console.log(`Source inventory: every checked file is at most ${maxLines} lines.`);
  process.exit(0);
}
for (const violation of violations.sort((a, b) => b.lines - a.lines)) {
  console.error(`${violation.lines} ${violation.path}`);
}
console.error(`${violations.length} source file(s) exceed ${maxLines} physical lines.`);
process.exit(1);

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (extensions.has(extension(entry))) inspect(path);
  }
}

function extension(name) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function inspect(path) {
  const source = readFileSync(path, "utf8");
  const lines = source === "" ? 0 : source.split("\n").length - Number(source.endsWith("\n"));
  if (lines > maxLines) violations.push({ path: relative(root, path), lines });
}
