import { isAbsolute } from "node:path";
import { shellCheckout } from "../../../support/repository-checkout";
export { observedCheckoutRoot as observedCodexWorktree } from "../../../support/repository-checkout";

/** Only explicit command working directories are observations, never chat prose. */
export function workdirsFromCodexCall(line: unknown): string[] {
  if (!line || typeof line!=="object") return [];
  const record=line as {type?:string;payload?:{type?:string;name?:string;input?:string;arguments?:string}};
  const p=record.payload;
  if (record.type!=="response_item") return [];
  if (p?.type==="function_call" && ["exec_command","functions.exec_command"].includes(p.name ?? "")) {
    try {
      const args=JSON.parse(p.arguments ?? "{}");
      const path=shellCheckout(args.cmd) ?? args.workdir;
      return typeof path==="string" && isAbsolute(path) ? [path] : [];
    } catch { return []; }
  }
  if (p?.type!=="custom_tool_call" || !["exec","functions.exec"].includes(p.name ?? "")
    || typeof p.input!=="string") return [];
  return [...p.input.matchAll(/\b["']?workdir["']?\s*:\s*(["'])(\/[^"'\r\n]+)\1/g)].map(m=>m[2]!);
}
