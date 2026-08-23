import { connectGrokBotInvite } from "../mesh/endpoint";

function inviteArgument(args: string[]): string {
  if (args.length === 1 && !["--help", "-h"].includes(args[0]!)) return args[0]!;
  process.stderr.write("Usage: granttap mesh connect <one-time-invite>\n");
  process.exit(1);
}

const invite = inviteArgument(process.argv.slice(2));
void connectGrokBotInvite(invite).then((bundle) => {
  process.stdout.write([
    "GrantTap Project Mesh",
    "",
    `Grok Bot endpoint  Connected (${bundle.endpoint.displayName})`,
    `Actors             ${bundle.actors.length}`,
    `Allowed projects   ${bundle.credential.projectIds.length}`,
    "",
    "Configure Grok Bot to run: granttap internal mesh-mcp",
    "The scoped MCP server cannot create invites, change relay, or expand Project access.",
    "",
  ].join("\n"));
}).catch((error: unknown) => {
  process.stderr.write(`[granttap] Grok Bot connection failed: ${
    error instanceof Error ? error.message : String(error)
  }\n`);
  process.exitCode = 1;
});
