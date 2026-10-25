import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const excludedSegment = /(?:^|\/)(?:\.git|\.github|tests?|scripts?|superpowers|plans?|roadmaps?|audits?|research|coverage|test-results)(?:\/|$)/i;
const excludedFile = /(?:^|\/)(?:(?:AGENTS|CODEX|CLAUDE)\.md|\.npmrc|\.env(?:\..*)?|.*\.(?:pem|key))$/i;

export function publicRuntimePath(path) {
  if (path.startsWith("node_modules/")) {
    if (/^node_modules\/\.bin(?:\/|$)/.test(path)) return false;
    if (/\.(?:map|d\.(?:ts|mts|cts))$/.test(path)) return false;
  }
  return !excludedSegment.test(path) && !excludedFile.test(path);
}

export function submissionManifest(source) {
  const { mcpServers: _servers, skills: _skills, interface: face, ...identity } = source;
  const { requires_local_executor: _desktop, ...portableIdentity } = identity;
  if (face.shortDescription.length > 30 || face.defaultPrompt.length > 3) {
    throw new Error("OpenAI listing exceeds public copy limits");
  }
  return {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ...portableIdentity,
    extensions: {
      "com.openai": {
        requires_local_executor: true,
        onboardingSkill: "./skills/granttap-connect/SKILL.md",
        interface: {
          ...face,
          longDescription: "Use GrantTap to inspect and control your local coding-agent work from Mac, iPhone, iPad, or Apple Watch. The included MCP runs on your computer and opens a private connection card for pairing and status. Requires a supported desktop host, Node.js 22.13 or newer, and authorized GrantTap access. The persistent GrantTap helper is required for monitoring agents while chats are closed. Provider sign-in, model charges, and permissions are separate. This desktop-only plugin does not run local agents from ChatGPT web or mobile.",
        },
        publication: {
          release_notes: "First OpenAI directory package: bundled local MCP runtime, connection workflow, privacy and support links. Desktop execution required.",
        },
      },
    },
  };
}

export function assemblePlugin({ output, runtimeRoot, root = repository }) {
  const destination = resolve(output);
  if (existsSync(destination) && readdirSync(destination).length) {
    throw new Error("Submission output directory must be empty");
  }
  const runtime = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (runtime.name !== "granttap-mcp" || runtime.version !== expected) {
    throw new Error("Submission runtime must match the repository's published version");
  }
  for (const path of ["bin/granttap-mcp.mjs", "node_modules/tsx/package.json"]) {
    if (!existsSync(join(runtimeRoot, path))) throw new Error(`Runtime is incomplete: ${path}`);
  }
  const source = join(root, "plugins/granttap");
  const compatibility = JSON.parse(readFileSync(join(source, ".codex-plugin/plugin.json"), "utf8"));
  mkdirSync(destination, { recursive: true });
  const manifest = submissionManifest(compatibility);
  writeFileSync(join(destination, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(destination, "mcp.json"), `${JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      granttap: {
        type: "stdio", command: "node",
        args: ["${PLUGIN_ROOT}/runtime/bin/granttap-mcp.mjs"],
        cwd: "${PLUGIN_ROOT}",
      },
    },
  }, null, 2)}\n`);
  for (const path of ["assets", "skills", "LICENSE", "NOTICE"]) {
    cpSync(join(source, path), join(destination, path), { recursive: true });
  }
  cpSync(runtimeRoot, join(destination, "runtime"), {
    recursive: true, verbatimSymlinks: true,
    filter: (path) => publicRuntimePath(path.slice(runtimeRoot.length).replace(/^\//, "")),
  });
  return { name: manifest.name, pluginVersion: manifest.version, runtimeVersion: runtime.version, output: destination };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, runtimeRoot] = process.argv.slice(2);
  if (!output || !runtimeRoot) throw new Error("Usage: node scripts/openai-submission/index.mjs OUTPUT PREPARED_RUNTIME");
  console.log(JSON.stringify(assemblePlugin({ output, runtimeRoot: resolve(runtimeRoot) })));
}
