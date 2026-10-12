const SECRET = /authorization|cookie|password|secret|(?:^|_)token(?:$|_)|api[_-]?key|private[_-]?key/i;

function safeText(value: string): string {
  let text = value.slice(0, 4_096).replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]");
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      url.username = "";
      url.password = "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET.test(key)) url.searchParams.set(key, "[redacted]");
      }
      text = url.toString();
    } catch { /* Keep a bounded non-URL parameter visible. */ }
  }
  return text;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[nested input omitted]";
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) =>
      [key, SECRET.test(key) ? "[redacted]" : redact(item, depth + 1)]));
  }
  return value;
}

/** Human inspection data only: it never changes provider input or risk policy. */
export function approvalPresentation(tool: string, input: Record<string, unknown>): {
  details?: string; title?: string;
} {
  if (Object.keys(input).length === 0) return {};
  const clean = redact(input) as Record<string, unknown>;
  const encoded = JSON.stringify(clean, null, 2);
  const details = encoded.length <= 16_384 ? encoded
    : encoded.slice(0, 16_340) + "\n[remaining parameters omitted]";
  const operations = clean.actions ?? clean.operations ?? clean.steps;
  const actions = Array.isArray(operations) ? operations.slice(0, 4).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const action = item.action ?? item.method ?? item.type ?? item.operation;
    return typeof action === "string" ? [action.slice(0, 48)] : [];
  }) : [];
  const description = clean.description ?? clean.purpose;
  const caption = actions.length ? actions.join(" → ")
    : typeof description === "string" ? description : undefined;
  const name = tool.split("__").at(-1) ?? tool;
  return { details, title: caption ? `${name}: ${caption}`.slice(0, 120) : undefined };
}
