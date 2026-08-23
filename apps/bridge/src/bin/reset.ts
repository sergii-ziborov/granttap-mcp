import { existsSync, renameSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { machineConfigPath, phonePairingPath } from "../config";

async function confirmed(args: string[]): Promise<boolean> {
  if (args.includes("--yes")) return true;
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      "Reset this computer's GrantTap phone pairing? Type RESET to continue: ",
    );
    return answer.trim() === "RESET";
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--yes", "--help", "-h"].includes(arg))) {
    process.stderr.write("Usage: granttap reset [--yes]\n");
    process.exitCode = 1;
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: granttap reset [--yes]\n");
    return;
  }
  const paths = [machineConfigPath(), phonePairingPath()].filter(existsSync);
  if (paths.length === 0) {
    process.stdout.write("GrantTap pairing is already reset.\n");
    return;
  }
  if (!(await confirmed(args))) {
    process.stderr.write("Pairing was not reset. Re-run interactively or pass --yes.\n");
    process.exitCode = 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const path of paths) renameSync(path, `${path}.reset-${stamp}`);
  process.stdout.write(
    "GrantTap pairing reset. Recoverable local backups were kept; run granttap connect to pair again.\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[granttap-mcp] reset failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
