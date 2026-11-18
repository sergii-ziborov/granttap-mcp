// Which station a shell command line belongs to. Ported from lot-map's hooks/classify.ts
// (https://github.com/alexeyw/lot-map, MIT, Copyright (c) 2026 Aleksei Volodin; the license is in
// THIRD_PARTY_LICENSES.txt). Here the line is only read to pick the station: no word of it leaves.
import type { LiveMapStation } from "../../../../../packages/protocol/schema";

const slashes = (path: string): string => path.replace(/\\/g, "/");

/** Commands that work on files and nothing else: they read, search, move or edit them in place. */
const FILE_WORDS = new Set(["cat", "head", "tail", "sed", "grep", "rg", "find", "ls", "wc", "cp", "mv", "mkdir",
  "touch", "diff", "cmp", "sort", "uniq", "cut", "tr", "awk", "tee", "stat", "file", "du", "tree", "ln", "basename",
  "dirname", "realpath", "jq", "rm", "rmdir", "fd", "bat", "nl", "less", "more", "xxd", "od", "chmod", "patch"]);
const NEUTRAL_WORDS = new Set(["echo", "printf", "cd", "export", "true", "false", ":", "set", "pwd", "sleep", "which",
  "test", "[", "[[", "read"]);
const NET_WORDS = new Set(["curl", "wget", "gh", "ssh", "scp", "sftp", "ftp", "rsync", "nc", "ncat", "telnet", "ping",
  "dig", "nslookup", "nmap", "http", "https", "kubectl", "aws", "gcloud", "az"]);
/** Commands that reach the network only with some of their subcommands. */
const NET_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(["push", "pull", "fetch", "clone", "ls-remote", "submodule update", "remote update"]),
  svn: new Set(["checkout", "co", "update", "up", "commit", "ci", "export"]),
  hg: new Set(["clone", "pull", "push", "incoming", "outgoing"]),
  npm: new Set(["install", "i", "ci", "add", "update", "publish", "view", "audit"]),
  pnpm: new Set(["install", "i", "add", "update", "publish", "dlx"]),
  yarn: new Set(["install", "add", "upgrade", "publish", "dlx"]),
  bun: new Set(["install", "i", "add", "update", "publish"]),
  pip: new Set(["install", "download"]),
  pipx: new Set(["install", "upgrade", "upgrade-all", "run"]),
  uv: new Set(["add", "sync", "lock", "publish", "tool install"]),
  poetry: new Set(["install", "add", "update", "lock", "publish"]),
  docker: new Set(["pull", "push", "login"]),
  "docker compose": new Set(["pull", "push"]),
  brew: new Set(["install", "update", "upgrade", "fetch"]),
  cargo: new Set(["install", "fetch", "publish", "update"]),
  go: new Set(["get", "install", "mod download"]),
  apt: new Set(["install", "update", "upgrade", "full-upgrade", "dist-upgrade"]),
  "apt-get": new Set(["install", "update", "upgrade", "dist-upgrade"]),
  deno: new Set(["install", "add", "cache"]),
  terraform: new Set(["init", "plan", "apply", "destroy", "import", "refresh"]),
  helm: new Set(["install", "upgrade", "pull", "push", "repo", "search", "dependency"]),
  openssl: new Set(["s_client"]),
};
const PY_MODULES = new Set(["pip", "uv", "pipx", "poetry"]);
/** Commands that run another command; `skip` is how many words of their own follow the flags. */
const WRAPPERS: Record<string, { takes?: readonly string[]; skip?: number; asks?: readonly string[] }> = {
  sudo: { takes: ["-u", "-g", "-p", "-h", "-C", "-D", "-R", "-T", "-U", "-r", "-t"] },
  doas: { takes: ["-u", "-C"] }, env: { takes: ["-u", "-C"] }, time: {},
  timeout: { takes: ["-s", "-k"], skip: 1 }, nohup: {}, nice: { takes: ["-n"] }, ionice: { takes: ["-c", "-n"] },
  stdbuf: { takes: ["-i", "-o", "-e"] }, caffeinate: { takes: ["-t", "-w"] }, command: { asks: ["-v", "-V"] },
  exec: { takes: ["-a"] }, xargs: { takes: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R"] },
  watch: { takes: ["-n", "--interval"] },
};
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const GIT_TAKES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const DOCKER_TAKES = new Set(["-c", "--context", "-H", "--host", "--config", "-l", "--log-level", "-f", "--file", "-p",
  "--project-name", "--profile", "--env-file", "--project-directory"]);
const DOCKER_ALONE = new Set(["-i", "-t", "-d", "-P", "-q", "-T", "--interactive", "--tty", "--detach", "--rm", "--init",
  "--privileged", "--publish-all", "--read-only", "--no-healthcheck", "--quiet", "--no-deps", "--build"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const BEFORE_A_COMMAND = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const NO_COMMAND = new Set(["for", "select", "case", "function", "done", "fi", "esac", "}"]);
/** A longer line is a script written inline, and what counts stands at its start. */
const READ = 8000;
const PS_FILE_WORDS = new Set(["get-content", "gc", "type", "set-content", "add-content", "out-file", "get-childitem",
  "gci", "dir", "get-item", "gi", "select-string", "sls", "copy-item", "cpi", "copy", "move-item", "mi", "move",
  "rename-item", "rni", "ren", "new-item", "ni", "md", "test-path", "resolve-path", "get-filehash"]);
const PS_NEUTRAL_WORDS = new Set(["write-host", "write-output", "set-location", "sl", "get-location", "gl",
  "start-sleep", "select-object", "select", "where-object", "where", "?", "foreach-object", "foreach", "%",
  "sort-object", "measure-object", "measure", "format-table", "ft", "format-list", "fl", "out-string", "out-null"]);
const PS_NET_WORDS = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm", "test-connection",
  "test-netconnection", "resolve-dnsname", "start-bitstransfer"]);

const pastFlags = (words: string[], takes: { has(flag: string): boolean }): string[] => {
  let i = 0;
  while (i < words.length && (words[i] ?? "").startsWith("-")) i += takes.has(words[i] ?? "") ? 2 : 1;
  return words.slice(i);
};

/** `sudo curl` is curl, and so is the curl behind `env A=1`, `timeout 5` or `xargs`. */
function unwrapped(words: string[], name: (word?: string) => string): string[] {
  let rest = words;
  for (let depth = 0; depth < 6; depth++) {
    const wrapper = WRAPPERS[name(rest[0])];
    if (wrapper === undefined || wrapper.asks?.some(flag => rest[1] === flag) === true) break;
    rest = pastFlags(rest.slice(1), new Set(wrapper.takes ?? []));
    let i = 0;
    while (i < rest.length && ASSIGNMENT.test(rest[i] ?? "")) i++;
    rest = rest.slice(i + (wrapper.skip ?? 0));
  }
  return rest;
}

/** What `docker exec` or `docker run` runs in a container: the words after the container's name. */
function insideContainer(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (words[i] ?? "").startsWith("-")) {
    const flag = words[i] ?? "";
    i += DOCKER_ALONE.has(flag) || flag.includes("=") || /^-[itdqPT]{2,}$/.test(flag) ? 1 : 2;
  }
  return words.slice(i + 1);
}

const unquoted = (word: string): string => {
  const q = word[0];
  if (q !== '"' && q !== "'") return word;
  const inner = word.length > 1 && word.endsWith(q) ? word.slice(1, -1) : word.slice(1);
  return q === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
};

/** A shell line without the text of its here-documents, unless a shell given no script runs them. */
function withoutHereDocuments(command: string): string {
  if (!command.includes("<<")) return command;
  const kept: string[] = [];
  const waiting: { word: string; tabs: boolean; isRun: boolean }[] = [];
  for (const line of command.split("\n")) {
    const open = waiting[0];
    if (open !== undefined) {
      const text = (open.tabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
      if (text === open.word) waiting.shift();
      else if (open.isRun) kept.push(line);
      continue;
    }
    kept.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][\w.]*)\2/g)) {
      const before = line.slice(0, m.index);
      if (before.lastIndexOf("((") > before.lastIndexOf("))")) continue;
      const feeds = unwrapped(segments(before).pop() ?? [], base);
      const isRun = SHELLS.has(base(feeds[0])) && feeds.slice(1).every(w => w.startsWith("-") && !/^-[a-z]*c$/.test(w));
      waiting.push({ word: m[3] ?? "", tabs: m[1] === "-", isRun });
    }
  }
  return kept.join("\n");
}

type Reading = { text: string; quote: "" | '"' | "'" | "$"; close: "" | ")" | "`" };

/** A shell line cut into its commands outside quotes; `deep` adds each command run inside `$(…)` or backticks. */
function pieces(line: string, deep: boolean, powershell: boolean): string[] {
  const out: string[] = [];
  const open: Reading[] = [{ text: "", quote: "", close: "" }];
  const escape = powershell ? "`" : "\\";
  const cut = (reading: Reading): void => { out.push(reading.text); reading.text = ""; };
  for (let i = 0; i < line.length; i++) {
    const top = open[open.length - 1] as Reading;
    const c = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (top.quote === "'") {
      top.text += c;
      if (c === "'") top.quote = "";
      continue;
    }
    if (c === "\\" && next === "\n" && !powershell) { top.text += " "; i++; continue; }
    if (c === escape || (c === "\\" && top.quote === "$")) { top.text += c + next; i++; continue; }
    const inside = deep && c === "$" && next === "(" ? ")" : deep && c === "`" && !powershell && top.close !== "`" ? "`" : "";
    if (top.quote !== "") {
      if ((top.quote === "$" && c === "'") || (top.quote === '"' && c === '"')) top.quote = "";
      if (top.quote === '"' && inside !== "") {
        open.push({ text: "", quote: "", close: inside });
        if (inside === ")") i++;
        top.text += " ";
      } else top.text += c;
      continue;
    }
    if (c === '"' || c === "'") { top.quote = c; top.text += c; }
    else if (c === "$" && next === "'" && !powershell) { top.quote = "$"; top.text += "$'"; i++; }
    else if (c === "#" && /^$|\s$/.test(top.text.slice(-1))) {
      while (i + 1 < line.length && line[i + 1] !== "\n") i++;
    } else if (c === "\n" || c === ";" || c === "|") cut(top);
    else if (c === "&" && (next === "&" || !powershell)) {
      // `2>&1` and `&>file` send output somewhere; they end no command.
      if (next !== "&" && (next === ">" || /[<>]/.test(line[i - 1] ?? ""))) top.text += c;
      else cut(top);
    } else if (inside !== "" || (deep && c === "(")) {
      open.push({ text: "", quote: "", close: inside === "`" ? "`" : ")" });
      if (inside === ")") i++;
      top.text += " ";
    } else if (deep && (c === ")" || c === "`") && !(c === "`" && powershell)) {
      cut(top);
      if (top.close === c && open.length > 1) open.pop();
    } else top.text += c;
  }
  for (const reading of open) out.push(reading.text);
  return out;
}

const WORDS = /(?:\\[\s\S]|[^\s"'\\]|"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?)+/g;
const PS_WORDS = /(?:[^\s"']|"[^"]*"?|'[^']*'?)+/g;

/** The words of each command in a shell line, leading assignments and construct words taken off. */
function segments(command: string, deep = false, constructs = false, powershell = false): string[][] {
  return pieces(command, deep, powershell)
    .map(part => part.match(powershell ? PS_WORDS : WORDS) ?? [])
    .map(words => {
      let i = 0;
      while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
      if (!constructs) return words.slice(i);
      let rest = words.slice(i);
      for (;;) {
        const head = rest[0] ?? "";
        if (BEFORE_A_COMMAND.has(head)) rest = rest.slice(1);
        else if (head.startsWith("(") && !head.startsWith("((")) rest = head.length > 1 ? [head.slice(1), ...rest.slice(1)] : rest.slice(1);
        else break;
      }
      return NO_COMMAND.has(rest[0] ?? "") ? [] : rest;
    })
    .filter(words => words.length > 0);
}

/** A command's own name: no quotes, no folder; a Windows program without `.exe` and in lower case. */
const base = (word = ""): string => {
  const name = slashes(word.replace(/["']/g, "")).split("/").pop() ?? word;
  return /\.(?:exe|cmd|bat)$/i.test(name) ? name.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase() : name;
};

/** Claude Code's memory folder; Codex keeps its memories under `~/.codex/memories`. */
export const isMemoryPath = (path: string): boolean =>
  /\/\.claude\/projects\/[^/]+\/memory\//.test(slashes(path)) || /\/\.codex\/memories\//.test(slashes(path));

/** The station of a shell tool's line. `powershell` adds PowerShell's names and reads them in lower case. */
export function shellStation(command: string, powershell = false): LiveMapStation {
  const name = (word?: string): string => (powershell ? base(word).toLowerCase() : base(word));
  const own = (words: string[]): string[] => {
    if (!powershell) return words;
    let i = 0;
    if (/^\$[\w:]+$/.test(words[0] ?? "") && words[1] === "=") i = 2;
    if (words[i] === "&" || words[i] === ".") i++;
    return words.slice(i);
  };
  const commands = (words: string[], deep = false, depth = 0): string[][] => {
    const outer = unwrapped(words, name);
    const head = name(outer[0]);
    if (!powershell && depth < 3) {
      let line: string | undefined;
      if (head === "eval") line = outer.slice(1).map(unquoted).join(" ");
      else if (SHELLS.has(head)) {
        const at = outer.findIndex((w, i) => i > 0 && !w.startsWith("-"));
        const flag = outer.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w));
        if (flag > 0 && (at < 0 || at > flag) && outer[flag + 1] !== undefined) line = unquoted(outer[flag + 1] ?? "");
      }
      if (line !== undefined) return segments(line, deep, true).flatMap(inner => commands(inner, deep, depth + 1));
    }
    const all = [outer];
    if (head === "find") {
      outer.forEach((word, i) => {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(word)) return;
        const tail = outer.slice(i + 1);
        const end = tail.findIndex(w => w === "\\;" || unquoted(w) === ";" || w === "+");
        all.push(...commands(end < 0 ? tail : tail.slice(0, end), deep, depth + 1));
      });
    }
    if (head === "docker" && depth < 3) {
      let rest = pastFlags(outer.slice(1), DOCKER_TAKES);
      if (rest[0] === "compose") rest = pastFlags(rest.slice(1), DOCKER_TAKES);
      if (rest[0] === "container") rest = rest.slice(1);
      if (rest[0] === "exec" || rest[0] === "run") all.push(...commands(insideContainer(rest.slice(1)), deep, depth + 1));
    }
    return all.filter(c => c.length > 0);
  };
  const isNet = (words: string[]): boolean => {
    let head = name(words[0]);
    let rest = words.slice(1);
    if (NET_WORDS.has(head) || (powershell && PS_NET_WORDS.has(head))) return true;
    if (/^(?:python[\d.]*|py)$/.test(head) && rest[0] === "-m" && PY_MODULES.has(rest[1] ?? "")) [head, rest] = [rest[1] ?? "", rest.slice(2)];
    if (head === "uv" && rest[0] === "pip") [head, rest] = ["pip", rest.slice(1)];
    if (/^pip[\d.]+$/.test(head)) head = "pip";
    if (head === "yarn" && rest.every(w => w.startsWith("-"))) return true;
    if (head === "git") rest = pastFlags(rest, GIT_TAKES);
    if (head === "docker") {
      rest = pastFlags(rest, DOCKER_TAKES);
      if (rest[0] === "compose") [head, rest] = ["docker compose", pastFlags(rest.slice(1), DOCKER_TAKES)];
    }
    if (head === "npx") return rest.some(w => w === "-y" || w === "--yes");
    const subs = NET_SUBCOMMANDS[head];
    return subs !== undefined && (subs.has(rest[0] ?? "") || subs.has(`${rest[0] ?? ""} ${rest[1] ?? ""}`));
  };
  const read = (powershell ? command : withoutHereDocuments(command)).slice(0, READ);
  const run = segments(read, false, !powershell, powershell).map(own).filter(words => words.length > 0)
    .flatMap(words => commands(words));
  if (run.some(isNet) || segments(read, true, !powershell, powershell).map(own)
    .flatMap(words => commands(words, true)).some(isNet)) return "web";
  const isNeutral = (head: string): boolean => NEUTRAL_WORDS.has(head) || (powershell && PS_NEUTRAL_WORDS.has(head));
  const isFile = (head: string): boolean => FILE_WORDS.has(head) || (powershell && PS_FILE_WORDS.has(head));
  const real = run.filter(words => !isNeutral(name(words[0])));
  if (real.length > 0 && real.every(words => isFile(name(words[0])))) return isMemoryPath(read) ? "memory" : "files";
  return "shell";
}
