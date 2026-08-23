import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import {
  formatConnectPasteText,
  pairUriDesktopPath,
  writePairUriDesktopFile,
} from "../apps/bridge/src/pair-uri-file";
import { ancestors, descriptorsForSession } from "../apps/bridge/src/capabilities/descriptors";

test("the desktop paste file and connect text always carry the full pairing URI", async (t) => {
  const desktop = join(await mkdtemp(join(tmpdir(), "granttap-desktop-")), "Desktop");
  process.env.GRANTTAP_DESKTOP_DIR = desktop;
  t.after(() => { delete process.env.GRANTTAP_DESKTOP_DIR; });

  const uri = "granttap://pair-v2?room=abc&key=def";
  const path = writePairUriDesktopFile(`  ${uri}  `);
  assert.equal(path, pairUriDesktopPath());
  assert.equal(await readFile(path, "utf8"), `${uri}\n`);

  const withDesktop = formatConnectPasteText({
    uri, httpBase: "https://relay.example", desktopPath: path,
  });
  assert.match(withDesktop, /PASTE THIS/);
  assert.match(withDesktop, /granttap:\/\/pair-v2\?room=abc&key=def/);
  assert.match(withDesktop, /Relay: https:\/\/relay\.example/);
  assert.match(withDesktop, /expires in \d+ minutes/);
  assert.match(withDesktop, new RegExp(`Also on Desktop: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const withoutDesktop = formatConnectPasteText({
    uri, httpBase: "https://relay.example", desktopPath: null,
  });
  assert.doesNotMatch(withoutDesktop, /Also on Desktop/);
});

test("Claude MCP descriptors merge the home config with project files up to the repository root", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "granttap-home-"));
  const repo = join(home, "repo");
  const nested = join(repo, "packages", "app");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { home: { command: "home-server" }, broken: "not-an-object" },
  }));
  await writeFile(join(repo, ".mcp.json"), JSON.stringify({
    mcpServers: { repo: { command: "repo-server" } },
  }));
  await writeFile(join(nested, ".mcp.json"), JSON.stringify({ mcpServers: null }));

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  assert.deepEqual(ancestors(nested), [nested, join(repo, "packages"), repo]);
  const descriptors = descriptorsForSession({
    sessionId: "claude-session", agent: "claude", cwd: nested,
  } as unknown as SessionInfo);
  assert.deepEqual(descriptors.map((item) => item.name), ["home", "repo"]);
  assert.equal(descriptors.every((item) => item.configuredEnabled), true);

  const withoutCwd = descriptorsForSession({
    sessionId: "claude-session", agent: "claude",
  } as unknown as SessionInfo);
  assert.deepEqual(withoutCwd.map((item) => item.name), ["home"]);
});
