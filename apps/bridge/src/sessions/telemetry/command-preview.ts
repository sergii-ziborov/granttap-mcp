export const MAX_COMMAND_PREVIEW_LENGTH = 160;

function commandValue(input: unknown, depth = 0): string | null {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const parts = input.filter((item): item is string => typeof item === "string");
    return parts.length === input.length && parts.length > 0 ? parts.join(" ") : null;
  }
  if (!input || typeof input !== "object" || depth > 1) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "shell_command", "shellCommand", "script"]) {
    const value = commandValue(record[key], depth + 1);
    if (value) return value;
  }
  return commandValue(record.action, depth + 1);
}

const REDACTED_COMMAND_VALUE = "[REDACTED]";
const SENSITIVE_NAME =
  "(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|auth(?:orization)?|password|passwd|pwd|credential(?:s)?|client[_-]?secret|private[_-]?key)";
const SENSITIVE_CONFIG_KEY = `[^\\s=;&|]*(?:${SENSITIVE_NAME})[^\\s=;&|]*`;
const SHELL_ARGUMENT_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`;

function redactCommandSecrets(raw: string): string {
  let value = raw;
  value = value.replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi,
    REDACTED_COMMAND_VALUE,
  );
  value = value.replace(
    new RegExp(
      `(\\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `(\\bcurl\\b(?:(?![;&|]).)*?\\s(?:-u|--user|--proxy-user)(?:\\s*=\\s*|\\s+))${SHELL_ARGUMENT_VALUE}`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(`((?:^|\\s)-p)(?!\\s|$)${SHELL_ARGUMENT_VALUE}`, "g"),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `(\\b(?:aws\\s+configure\\s+set|npm\\s+(?:config\\s+)?set)\\s+${SENSITIVE_CONFIG_KEY}(?:\\s*=\\s*|\\s+))${SHELL_ARGUMENT_VALUE}`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `((?:^|\\s)--?${SENSITIVE_NAME}(?:\\s*=\\s*|\\s+))(?:"[^"]*"|'[^']*'|[^\\s;&|]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `((?:${SENSITIVE_NAME}|x-api-key|proxy-authorization)\\s*:\\s*)(?:bearer\\s+|basic\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    new RegExp(
      `(["']?(?:${SENSITIVE_NAME})["']?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
      "gi",
    ),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    `$1${REDACTED_COMMAND_VALUE}@`,
  );
  value = value.replace(
    new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]+`, "gi"),
    `$1${REDACTED_COMMAND_VALUE}`,
  );
  value = value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED_COMMAND_VALUE)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, REDACTED_COMMAND_VALUE)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED_COMMAND_VALUE)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, REDACTED_COMMAND_VALUE)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED_COMMAND_VALUE)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED_COMMAND_VALUE,
    );
  return value;
}

/** The whole command, secrets removed and whitespace collapsed, not cut. */
export function commandTextFromInput(input: unknown): string | null {
  const raw = commandValue(input);
  if (!raw) return null;
  const collapsed = redactCommandSecrets(raw)
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return collapsed || null;
}

export function commandPreviewFromInput(input: unknown): string | null {
  const collapsed = commandTextFromInput(input);
  return collapsed ? collapsed.slice(0, MAX_COMMAND_PREVIEW_LENGTH) : null;
}
