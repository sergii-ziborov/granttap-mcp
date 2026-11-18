import assert from "node:assert/strict";
import test from "node:test";
import { classifyCall, commandOf, modelName, pulseName, shellStation } from "..";

const MARK = "SECRET-MARK-7f3a";

test("Claude Code's tools light lot-map's stations", () => {
  const cases: Array<[string, unknown, string]> = [
    ["Read", { file_path: `/Users/me/${MARK}/a.ts` }, "files"],
    ["Edit", { file_path: "/Users/me/.claude/projects/-x/memory/notes.md" }, "memory"],
    ["Grep", { pattern: MARK }, "files"],
    ["Glob", { pattern: MARK }, "files"],
    ["WebFetch", { url: `https://${MARK}.example.com/a?q=${MARK}` }, "web"],
    ["WebSearch", { query: MARK }, "web"],
    ["Agent", { description: MARK, prompt: MARK }, "agents"],
    ["Skill", { skill: "design:design-critique" }, "skills"],
    ["ToolSearch", { query: MARK }, "skills"],
    ["AskUserQuestion", { questions: [MARK] }, "you"],
    ["TodoWrite", { todos: [MARK] }, "you"],
    ["mcp__Claude_Browser__navigate", { url: `https://${MARK}.test` }, "browser"],
    ["mcp__claude-in-chrome__click", {}, "browser"],
    ["mcp__remote-devices__Claude_Browser__read_page", {}, "browser"],
    ["mcp__memory__recall", { query: MARK }, "memory"],
    ["mcp__granttap__ask", { question: MARK }, "you"],
    ["mcp__plugin-authoring__validate", {}, "skills"],
    ["mcp__github__create_issue", { body: MARK }, "web"],
    ["SomethingNew", { anything: MARK }, "shell"],
  ];
  for (const [tool, input, station] of cases) {
    const call = classifyCall(tool, input);
    assert.equal(call.station, station, tool);
    assert.equal(JSON.stringify(call).includes(MARK), false, `${tool} must not carry content`);
  }
});

test("Codex, Cursor and Grok Build tool names light the same stations", () => {
  const cases: Array<[string, unknown, string]> = [
    ["exec_command", { cmd: `rg ${MARK} src` }, "files"],
    ["exec_command", { cmd: `curl https://${MARK}.test` }, "web"],
    ["shell", { command: ["bash", "-lc", `npm test -- ${MARK}`] }, "shell"],
    ["local_shell_call", { command: ["git", "push", "origin", MARK] }, "web"],
    ["apply_patch", `*** Begin Patch\n*** Update File: ${MARK}.ts`, "files"],
    ["update_plan", { plan: [MARK] }, "you"],
    ["request_user_input", { questions: [MARK] }, "you"],
    ["spawn_agent", { message: MARK, agent_type: "worker" }, "agents"],
    ["wait", {}, "agents"],
    ["web_search", { query: MARK }, "web"],
    ["view_image", { path: MARK }, "files"],
    ["Shell", `cat ${MARK}.txt`, "files"],
    ["StrReplace", { path: MARK }, "files"],
    ["CallMcpTool", { server: "user-granttap", toolName: "notify", arguments: MARK }, "you"],
    ["GetMcpTools", { server: "user-linear" }, "skills"],
    ["run_terminal_cmd", { command: `docker pull ${MARK}` }, "web"],
    ["bash", { command: `ls ${MARK}` }, "files"],
    ["read_file", { path: MARK }, "files"],
    ["browser_navigate", { url: MARK }, "browser"],
  ];
  for (const [tool, input, station] of cases) {
    const call = classifyCall(tool, input);
    assert.equal(call.station, station, `${tool} ${JSON.stringify(input)}`);
    assert.equal(JSON.stringify(call).includes(MARK), false, `${tool} must not carry content`);
  }
});

test("a call goes by its tool's name, or a skill or agent type that is a plain identifier", () => {
  assert.equal(classifyCall("exec_command", { cmd: "ls" }).name, "exec command");
  assert.equal(classifyCall("mcp__github__create_issue", {}).name, "github: create issue");
  assert.equal(classifyCall("CallMcpTool", { server: "user-granttap", toolName: "ask_yes_no" }).name, "granttap: ask yes no");
  assert.equal(classifyCall("Skill", { skill: "design:design-critique" }).name, "design:design-critique");
  assert.equal(classifyCall("Skill", { skill: `run ${MARK} now` }).name, "Skill");
  assert.equal(classifyCall("Agent", { subagent_type: "Explore", description: MARK }).name, "Explore");
  assert.equal(classifyCall("Agent", { subagent_type: "a b c" }).name, "Agent");
  assert.equal(classifyCall("spawn_agent", { agent_type: "worker" }).name, "worker");
  assert.equal(classifyCall("PowerShell", { command: "Invoke-WebRequest https://x.test" }).station, "web");
  assert.equal(classifyCall("PowerShell", { command: "Get-Content a.txt" }).station, "files");
});

test("names lose control and direction characters and stay short", () => {
  assert.equal(pulseName("Bash\u001b[31m\u202e"), "Bash [31m");
  assert.equal(pulseName("x".repeat(90)).length, 64);
  assert.equal(pulseName("<synthetic>"), "tool");
  assert.equal(pulseName("", "Agent"), "Agent");
  assert.equal(modelName("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelName("gpt-6-codex"), "gpt-6-codex");
  assert.equal(modelName("<synthetic>"), undefined);
  assert.equal(modelName(42), undefined);
});

test("a provider's command shapes read as one line", () => {
  assert.equal(commandOf("ls -la"), "ls -la");
  assert.equal(commandOf({ cmd: "npm test" }), "npm test");
  assert.equal(commandOf({ command: ["/bin/zsh", "-lc", "git status"] }), "git status");
  assert.equal(commandOf({ command: ["git", "commit", "-m", "a b"] }), "git commit -m 'a b'");
  assert.equal(commandOf({ action: { command: ["rg", "x"] } }), "rg x");
  assert.equal(commandOf({ command: [1, 2] }), "");
  assert.equal(commandOf(undefined), "");
});

test("shell lines are read by the command they run, as lot-map reads them", () => {
  const cases: Array<[string, string]> = [
    ["cat a | grep b | wc -l", "files"],
    ["echo hi && cd src && ls", "files"],
    ["npm test", "shell"],
    ["npm install left-pad", "web"],
    ["sudo -u me curl https://x", "web"],
    ["timeout 5 git -C repo fetch origin", "web"],
    ["env A=1 B=2 pnpm add zod", "web"],
    ["python3 -m pip install requests", "web"],
    ["uv pip install x", "web"],
    ["npx tsc", "shell"],
    ["npx -y create-thing", "web"],
    ["bash -c \"curl https://x\"", "web"],
    ["eval \"wget x\"", "web"],
    ["for f in a b; do curl $f; done", "web"],
    ["if true; then rm -rf build; fi", "files"],
    ["echo $(gh pr list)", "web"],
    ["echo \"a|b\" | grep -E 'a|b' file", "files"],
    ["find . -name x -exec curl {} \\;", "web"],
    ["docker run --rm -it node:22 npm install", "web"],
    ["docker compose -f x.yml pull", "web"],
    ["cat <<EOF > out.txt\ncurl https://x\nEOF", "files"],
    ["bash <<EOF\ncurl https://x\nEOF", "web"],
    ["yarn", "web"],
    ["pip3.12 install x", "web"],
    ["git status 2>&1 # curl", "shell"],
    ["(cd x && ls -la)", "files"],
    ["xargs -n 1 rm", "files"],
    ["cat ~/.claude/projects/-a/memory/MEMORY.md", "memory"],
    ["command -v curl", "shell"],
    ["ls \\\n  -la", "files"],
    ["echo $'a\\'b' && ls", "files"],
    ["(( a << 2 )) && make", "shell"],
    ["echo `curl x`", "web"],
  ];
  for (const [line, station] of cases) assert.equal(shellStation(line), station, line);
  assert.equal(shellStation("$r = Invoke-RestMethod https://x", true), "web");
  assert.equal(shellStation("& \"C:\\Program Files\\Git\\cmd\\git.exe\" push", true), "web");
  assert.equal(shellStation("Get-ChildItem | Select-Object Name", true), "files");
  assert.equal(shellStation("CURL.EXE https://x"), "web");
});
