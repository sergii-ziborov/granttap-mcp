#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const limits = { file: 400, function: 100, requiredParameters: 5, folder: 6 };
const codeExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".swift", ".css", ".sh", ".py", ".rb"]);
const parsedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const ignored = new Set([".git", "node_modules", "coverage", "dist", "build", "DerivedData", ".release"]);
const root = process.cwd();
const violations = [];
let checkedFiles = 0;

function lineAt(source, offset) {
  return source.getLineAndCharacterOfPosition(offset).line + 1;
}

function functionName(node, source) {
  if (node.name) return node.name.getText(source);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
      return parent.name.getText(source);
    }
  }
  return "anonymous";
}

function inspectFunctions(path, contents) {
  const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  function visit(node) {
    // A test callback is a scenario container; its named helpers are still checked.
    const parentCall = node.parent && ts.isCallExpression(node.parent) ? node.parent : null;
    const testCase = parentCall && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ["test", "it", "describe"].includes(parentCall.expression.getText(source));
    const hasBody = "body" in node && node.body != null;
    const isFunction = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node);
    if (isFunction && hasBody && !testCase) {
      const name = functionName(node, source);
      const length = lineAt(source, node.end) - lineAt(source, node.getStart(source)) + 1;
      const required = node.parameters.filter((param) => !param.questionToken && !param.initializer).length;
      if (length > limits.function) {
        violations.push(`FUNCTION ${length} lines ${path}:${lineAt(source, node.getStart(source))} ${name}`);
      }
      if (required > limits.requiredParameters) {
        violations.push(`PARAMETERS ${required} required ${path}:${lineAt(source, node.getStart(source))} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function inspectFile(path) {
  checkedFiles += 1;
  const contents = readFileSync(path, "utf8");
  const lines = contents ? contents.split("\n").length - Number(contents.endsWith("\n")) : 0;
  const label = relative(root, path);
  if (lines > limits.file) violations.push(`FILE ${lines} lines ${label}`);
  if (parsedExtensions.has(extname(path))) inspectFunctions(label, contents);
}

function walk(directory) {
  const code = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (entry.isFile() && codeExtensions.has(extname(entry.name))) {
      code.push(entry.name);
      inspectFile(path);
    }
  }
  if (code.length > limits.folder) {
    violations.push(`FOLDER ${code.length} code files ${relative(root, directory) || "."}`);
  }
}

walk(root);
console.log(`Structure: ${checkedFiles} files checked, ${violations.length} violation(s).`);
for (const violation of violations) console.log(violation);
if (process.argv.includes("--strict") && violations.length) process.exitCode = 1;
