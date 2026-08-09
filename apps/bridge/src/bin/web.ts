#!/usr/bin/env -S npx tsx
/** Print the private Web approval capability only after an explicit command. */
import { listCloudApprovals, validatedCloudPageUrl } from "../cloud-approvals";
import { loadConfig, machineConfigPath } from "../config";

async function main(): Promise<void> {
  try {
    const config = loadConfig(machineConfigPath());
    const result = await listCloudApprovals(config);
    const pageUrl = result.ok
      ? validatedCloudPageUrl(config.relayUrl, result.pageUrl)
      : null;
    if (!pageUrl) throw new Error("relay capability unavailable");
    process.stdout.write([
      "",
      "GrantTap Web link (private capability — do not post or log it):",
      "",
      `  ${pageUrl}`,
      "",
      "Open GrantTap Web, unlock your encrypted vault, and choose Add computer.",
      "The browser stores this link only inside the encrypted GTW1 vault.",
      "",
    ].join("\n"));
  } catch {
    // Never echo relay bodies, URLs, local paths, or credentials on failure.
    process.stderr.write(
      "GrantTap Web is not ready. Run granttap connect, verify the relay, and try again.\n",
    );
    process.exitCode = 1;
  }
}

void main();
