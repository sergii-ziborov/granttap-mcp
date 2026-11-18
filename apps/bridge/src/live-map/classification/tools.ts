// Which station a tool call lights and the name it goes by. The Claude Code rules are ported from
// lot-map's hooks/classify.ts (https://github.com/alexeyw/lot-map, MIT, Copyright (c) 2026 Aleksei
// Volodin; the license is in THIRD_PARTY_LICENSES.txt), then extended to the tool names Codex, Cursor
// and Grok Build write. The input is read here to choose a station and nothing of it is returned:
// a label is a tool, skill or agent type name, never a path, a host, a command or a description.
import { PULSE_NAME, type LiveMapStation } from "../../../../../packages/protocol/schema";
import { isMemoryPath, shellStation } from "./shell";

export type ClassifiedCall = { station: LiveMapStation; name: string };

/** Tool names compared without case or separators: `exec_command`, `ExecCommand` and `exec-command` agree. */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const table = (station: LiveMapStation, names: string): Array<[string, LiveMapStation]> =>
  names.split(" ").map(name => [name, station]);

const BY_NAME = new Map<string, LiveMapStation>([
  // lot-map: Read, Write, Edit, NotebookEdit, Grep, Glob, LSP. Codex, Cursor and Grok: their file tools.
  ...table("files", "read write edit multiedit notebookedit editnotebook grep glob lsp ls readfile writefile "
    + "editfile createfile deletefile delete strreplace strreplacebasededittool texteditor applypatch listdir "
    + "listdirectory listfiles filesearch search codebasesearch readlints viewimage readmanyfiles findfiles "
    + "searchfiles searchreplace replace"),
  // lot-map: Bash, PowerShell, Monitor. Codex's shell tools, Cursor's Shell and terminal, Grok's bash.
  ...table("shell", "bash powershell monitor bashoutput killshell killbash shell execcommand localshellcall "
    + "localshell shellcommand unifiedexec writestdin runterminalcmd runinterminal runcommand executecommand "
    + "terminal runshellcommand"),
  // lot-map: web fetch and search, work kept on claude.ai. Codex's web search; Cursor's and Grok's fetch.
  ...table("web", "webfetch websearch artifact artifactcomments artifactdata sendtoproject sendtoprojectcontext "
    + "projects claudedesign designsync shareonboardingguide publishplugin websearchcall websearchpreview fetch "
    + "fetchurl imagegeneration imagegen"),
  // lot-map: subagents, workflows, schedules, background work. Codex's and Grok's agent tools; Cursor's Task.
  ...table("agents", "agent task workflow sendmessage taskstop listagents croncreate crondelete cronlist "
    + "schedulewakeup remotetrigger subagenthandback sendfile poll yield readnotifications taskoutput spawnagent "
    + "sendinput wait waitagent closeagent resumeagent spawnsubagent delegate subagent"),
  // lot-map: skills, tool search and the skill, plugin and connector catalogue. Cursor's MCP tool list.
  ...table("skills", "skill toolsearch listskills searchskills suggestskills listplugins searchplugins "
    + "suggestplugininstall listconnectors searchmcpregistry suggestconnectors waitformcpservers getmcptools"),
  // lot-map: what is shown to or asked of the person. Codex's plan and question tools; Cursor's to-dos.
  ...table("you", "askuserquestion senduserfile taskcreate taskupdate tasklist taskget todowrite enterplanmode "
    + "exitplanmode pushnotification reportfindings sendusermessage fetchinboxmessage sendfeedback proposegoal "
    + "proposeskills wrapup showonboardingrolepicker offerchromesetup readwidgetcontext endconversation "
    + "updateplan requestuserinput askquestion askuser todoread createplan"),
]);

/** MCP servers whose tools are a browser: lot-map's two, and the usual browser automation servers. */
const BROWSER_SERVERS = /^(?:claude_browser|claude-in-chrome|playwright|chrome-devtools|browsermcp|puppeteer|browser)$/i;
/** MCP servers whose tools reach the person: GrantTap's own questions and notices. */
const PERSON_SERVERS = /^(?:granttap|plugin_granttap_granttap|visualize|ccd_.+)$/i;
const MEMORY_SERVERS = /^(?:memory|mem0|memory-bank)$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** A name as it may travel: no control or direction characters, at most 64 characters. */
export function pulseName(raw: string, fallback = "tool"): string {
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ")
    .replace(/_+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 64).trim();
  return PULSE_NAME.test(text) ? text : fallback;
}

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The command line a shell tool was given, in whichever shape the provider wrote it. */
export function commandOf(input: unknown): string {
  if (typeof input === "string") return input;
  const i = record(input);
  const value = i.command ?? i.cmd ?? i.script ?? record(i.action).command;
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every(word => typeof word === "string")) return "";
  const words = value as string[];
  if (words.length >= 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(words[0]!) && /^-[a-z]*c$/.test(words[1]!)) return words[2]!;
  return words.map(shellWord).join(" ");
}

const pathOf = (input: unknown): string => {
  const i = record(input);
  return str(i.file_path) || str(i.notebook_path) || str(i.path) || str(i.target_file) || (typeof input === "string" ? input : "");
};

function mcpCall(server: string, tool: string): ClassifiedCall {
  const label = pulseName(`${server}: ${tool}`, pulseName(server));
  if (MEMORY_SERVERS.test(server)) return { station: "memory", name: label };
  const remote = server === "remote-devices" && /^Claude_Browser__/.test(tool);
  if (BROWSER_SERVERS.test(server) || remote) return { station: "browser", name: label };
  if (PERSON_SERVERS.test(server)) return { station: "you", name: label };
  if (server === "terminal") return { station: "shell", name: label };
  if (server === "plugin-authoring") return { station: "skills", name: label };
  return { station: "web", name: label };
}

/** Cursor runtime MCP ids (`user-granttap`) name the server as `mcp.json` does (`granttap`). */
const serverName = (raw: string): string => raw.trim().replace(/^user-/, "");

/** The station and the name of one tool call. */
export function classifyCall(tool: string, input: unknown): ClassifiedCall {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  if (mcp) return mcpCall(serverName(mcp[1]!), mcp[2]!);
  const i = record(input);
  if (/^(?:CallMcpTool|ReadMcpResourceTool|ListMcpResourcesTool|ReadMcpResourceDirTool)$/i.test(tool) && str(i.server)) {
    return mcpCall(serverName(str(i.server)), str(i.toolName) || tool);
  }
  const normalized = key(tool);
  const station = BY_NAME.get(normalized) ?? (/^browser/.test(normalized) ? "browser" : "shell");
  const name = pulseName(tool);
  if (normalized === "skill") return { station, name: IDENTIFIER.test(str(i.skill)) ? str(i.skill) : name };
  if (normalized === "agent" || normalized === "task" || normalized === "spawnagent") {
    const type = str(i.subagent_type) || str(i.agent_type);
    return { station, name: IDENTIFIER.test(type) ? type : name };
  }
  if (station === "shell") {
    const command = commandOf(input);
    return { station: command ? shellStation(command, normalized === "powershell") : "shell", name };
  }
  if (station === "files") return { station: isMemoryPath(pathOf(input)) ? "memory" : "files", name };
  return { station, name };
}

/** `claude-opus-5-5` and `gpt-6-codex` as they may travel; anything else is not a model name. */
export function modelName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.startsWith("<")) return undefined;
  const name = raw.trim().slice(0, 64);
  return PULSE_NAME.test(name) ? name : undefined;
}
