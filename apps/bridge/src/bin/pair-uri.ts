/**
 * Print a one-time granttap://pair-v2 URI to stdout (and Desktop file).
 * Usage: granttap-mcp pair-uri [relayUrl]
 */
import { writePairUriDesktopFile } from "../pair-uri-file";
import { createOneTimePairing, DEFAULT_RELAY } from "../pairing";

const relayUrl =
  process.argv[2] ??
  process.env.GRANTTAP_RELAY_URL ??
  process.env.NODVOX_RELAY_URL ??
  DEFAULT_RELAY;

void createOneTimePairing(relayUrl, {
  installHooks: process.env.GRANTTAP_SKIP_HOOKS !== "1",
})
  .then((pairing) => {
    const desktopPath = writePairUriDesktopFile(pairing.qrPayload);
    // Machine-readable: URI alone on stdout for scripts / Desktop consumers.
    process.stdout.write(`${pairing.qrPayload}\n`);
    process.stderr.write(`[granttap-mcp] wrote ${desktopPath}\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[granttap-mcp] pair-uri failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
