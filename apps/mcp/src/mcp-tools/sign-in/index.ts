import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isSignInUrl } from "../../../../../packages/protocol/schema";
import { holdRelay, relay } from "../connect/relay";
import { answered, notPaired, refused, type ToolAnswer } from "../interaction/answers";
import { attributedScope } from "../interaction/publish";
import { requestSignIn, type SignInOutcome } from "./pending";

const TOOL = "request_sign_in";

/** Longer than a question: a sign-in is a password manager, a second factor and a consent page. */
const SIGN_IN_TIMEOUT_MS = Number(process.env.GRANTTAP_SIGN_IN_TIMEOUT_MS ?? 300_000);

const DESCRIPTION =
  "Ask the person to sign in to a service on their phone, in a browser inside GrantTap, and wait for the outcome. "
  + "Use this whenever a CLI or service needs the person to sign in through a browser (wrangler login, gh auth login, "
  + "vercel login, an OAuth consent page, a device-code page): call it with the sign-in URL instead of opening a browser "
  + "on this computer, where nobody may be sitting. When the CLI waits for a redirect to http://localhost:<port>/…, pass "
  + "that port as callbackPort: the redirect the phone's browser receives is delivered once to that port on this "
  + "computer. Returns completed (with the HTTP status the CLI answered the redirect with, when one was delivered), "
  + "cancelled, or timed_out; a timeout is not a refusal, and completed without a delivered redirect means the person "
  + "says they finished, so check the CLI. Never put passwords, tokens or codes in chat: the person enters them only on "
  + "the sign-in page, and this tool never returns the page, its cookies or the redirect's contents.";

const input = {
  url: z.string().trim().min(1).max(8_192).describe("The https sign-in page to open on the phone"),
  service: z.string().trim().min(1).max(80).describe('A short name for the service, e.g. "Cloudflare"'),
  callbackPort: z.number().int().min(1).max(65_535).optional().describe(
    "The loopback port on this computer where the CLI waits for the OAuth redirect, e.g. 8976 for wrangler. "
    + "Omit it for a device-code page.",
  ),
  reason: z.string().trim().min(1).max(300).optional().describe("One line on why the sign-in is needed"),
};

const output = {
  status: z.enum(["completed", "cancelled", "timed_out"]).describe(
    "completed: the person finished on the phone; cancelled: the person declined; timed_out: nobody answered in time",
  ),
  callback: z.enum(["relayed", "unreachable", "none"]).describe(
    "relayed: the browser's redirect was delivered to callbackPort; unreachable: there was a redirect but nothing "
    + "accepted it on callbackPort; none: no redirect was captured or no callbackPort was given",
  ),
  callbackStatus: z.number().int().nullable().describe("The HTTP status the CLI answered the delivered redirect with"),
};

export function signInText(outcome: SignInOutcome, callbackPort?: number): string {
  if (outcome.status === "timed_out") return "no-answer (timeout): nobody completed the sign-in on the phone";
  if (outcome.status === "cancelled") return "cancelled: the person declined the sign-in on the phone";
  if (outcome.callback === "relayed") {
    return `signed in: the browser's redirect was delivered to localhost:${callbackPort} (HTTP ${outcome.callbackStatus})`;
  }
  if (outcome.callback === "unreachable") {
    return `signed in on the phone, but nothing accepted the redirect on localhost:${callbackPort}; `
      + "the CLI may have stopped waiting, so start it again and ask once more";
  }
  return "the person finished the sign-in on the phone; no redirect was delivered, so check the CLI";
}

export function registerSignInTool(server: McpServer, options: { timeoutMs?: number } = {}): void {
  const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  server.registerTool(
    TOOL,
    {
      description: DESCRIPTION,
      inputSchema: input,
      outputSchema: output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, service, callbackPort, reason }): Promise<ToolAnswer> => {
      // The address is not repeated in the refusal: a URL can carry what must not reach a transcript.
      if (!isSignInUrl(url)) return refused("request_sign_in opens https pages only, without a user name or password in the address.");
      const client = await relay();
      if (!client) return notPaired();
      const scope = attributedScope(TOOL, { url, service, callbackPort, reason });
      const release = holdRelay();
      try {
        const outcome = await requestSignIn(client, { url, service, reason, callbackPort, sessionId: scope?.sessionId, timeoutMs });
        return answered(signInText(outcome, callbackPort), outcome);
      } catch {
        return refused("The sign-in request could not be sent to the phone. Check the GrantTap connection and try again.");
      } finally {
        release();
      }
    },
  );
}
