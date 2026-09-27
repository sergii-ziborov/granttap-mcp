/** A deliberately narrow grammar for commands that can skip a safe-mode prompt. */
const SIMPLE = new Set(["pwd", "true", "false", "whoami", "echo", "cat", "wc", "which", "type"]);
const GIT_OPTIONS: Record<string, RegExp> = {
  status: /^(?:--short|--branch|--porcelain(?:=v[12])?|--show-stash|-s|-b|-sb)$/,
  diff: /^(?:--stat|--name-only|--name-status|--cached|--staged|--no-ext-diff|--no-textconv|-U\d{1,2})$/,
  log: /^(?:--oneline|--stat|--all|--decorate|--no-decorate|-n\d{1,3}|--max-count=\d{1,3})$/,
  show: /^(?:--stat|--name-only|--no-ext-diff|--no-textconv)$/,
  branch: /^(?:--list|--show-current|-a|-r|-v|-vv)$/,
  "rev-parse": /^(?:--show-toplevel|--short|--verify|--is-inside-work-tree|--abbrev-ref)$/,
};
const RG_OPTIONS = /^(?:-n|-i|-F|-l|--line-number|--ignore-case|--fixed-strings|--files-with-matches|--files|--hidden|--no-ignore|-g|--glob)$/;
const GREP_OPTIONS = /^(?:-n|-i|-E|-F|-R|-r|-l|--line-number|--ignore-case|--extended-regexp|--fixed-strings|--recursive)$/;
const FIND_OPTIONS = new Set(["-name", "-path", "-type", "-maxdepth", "-mindepth", "-a", "-o"]);

function safeArguments(command: string, args: string[]): boolean {
  if (SIMPLE.has(command)) return args.every((arg) => !arg.startsWith("-"));
  if (command === "date" || command === "uname") return args.every((arg) => !arg.startsWith("-"));
  if (command === "ls") return args.every((arg) => !arg.startsWith("-") || /^-[AalhR1]+$/.test(arg));
  if (command === "head" || command === "tail") {
    return args.every((arg, index) => !arg.startsWith("-")
      || arg === "-n" && /^\d{1,5}$/.test(args[index + 1] ?? ""));
  }
  if (command === "rg") return args.every((arg) => !arg.startsWith("-") || RG_OPTIONS.test(arg));
  if (command === "grep") return args.every((arg) => !arg.startsWith("-") || GREP_OPTIONS.test(arg));
  if (command === "find") return args.every((arg) => !arg.startsWith("-") || FIND_OPTIONS.has(arg));
  if (command !== "git") return false;
  const [subcommand, ...rest] = args;
  const options = subcommand ? GIT_OPTIONS[subcommand] : undefined;
  return options != null && rest.every((arg) => !arg.startsWith("-") || options.test(arg));
}

export function isSafeReadonlyShell(command: string | null | undefined): boolean {
  const raw = (command ?? "").trim();
  if (!raw || raw.length > 500 || /[\n\r|&;><`$\\*?\[\]]/.test(raw)) return false;
  const parts = raw.split(/\s+/);
  const executable = parts.shift() ?? "";
  if (executable.includes("/") && !["/usr/bin/grep", "/bin/ls", "/usr/bin/git"].includes(executable)) {
    return false;
  }
  return safeArguments(executable.split("/").at(-1) ?? "", parts);
}
