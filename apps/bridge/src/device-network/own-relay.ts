import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

// Updated only after the exact relay revision passes its release checks.
export const RELAY_SOURCE_COMMIT = "b6fff78de5881e107e3f475bc75b4c1503c1bbcf";
const RELAY_REPOSITORY = "https://github.com/sergii-ziborov/granttap-relay.git";
const runFile = promisify(execFile);
type Runner = (file: string, args: string[], cwd: string) => Promise<string>;

export class OwnRelay {
  constructor(private readonly root = join(configDir(), "own-relay"),
    private readonly run: Runner = async (file, args, cwd) =>
      (await runFile(file, args, { cwd, timeout: 120_000, maxBuffer: 256_000 })).stdout.trim()) {}

  private get source(): string { return join(this.root, "source"); }
  private get receipt(): string { return join(this.root, "installation.json"); }
  private get runtime(): string { return join(this.root, "runtime.json"); }

  installed(): boolean {
    if (!existsSync(this.receipt)) return false;
    try {
      const receipt = JSON.parse(readFileSync(this.receipt, "utf8"));
      return receipt.commit === RELAY_SOURCE_COMMIT
        && existsSync(join(this.source, "src/node/server.js"));
    } catch { return false; }
  }

  async install(): Promise<void> {
    if (this.installed()) return;
    if (existsSync(this.source) || existsSync(this.receipt)) {
      throw new Error("Existing relay files require an explicit upgrade; they were retained");
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const staging = join(this.root, `install-${process.pid}`);
    if (existsSync(staging)) throw new Error("An earlier relay installation was retained");
    try {
      await this.run("git", ["clone", "--no-checkout", "--", RELAY_REPOSITORY, staging], this.root);
      await this.run("git", ["checkout", "--detach", RELAY_SOURCE_COMMIT], staging);
      const commit = await this.run("git", ["rev-parse", "HEAD"], staging);
      if (commit !== RELAY_SOURCE_COMMIT) throw new Error("Relay revision could not be verified");
      await this.run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], staging);
      renameSync(staging, this.source);
      writePrivateFile(this.receipt, JSON.stringify({ commit, repository: RELAY_REPOSITORY }));
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  private async ownedPID(): Promise<number | null> {
    if (!existsSync(this.runtime)) return null;
    try {
      const { pid } = JSON.parse(readFileSync(this.runtime, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 2) return null;
      const command = await this.run("ps", ["-p", String(pid), "-o", "command="], this.root);
      const entry = realpathSync(join(this.source, "src/node/server.js"));
      return command.endsWith(` ${entry}`) ? pid : null;
    } catch { return null; }
  }

  async status(): Promise<{ installed: boolean; running: boolean }> {
    return { installed: this.installed(), running: await this.ownedPID() !== null };
  }

  async start(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid relay port");
    if (!this.installed()) throw new Error("Install the own relay first");
    if (await this.ownedPID() !== null) {
      if (JSON.parse(readFileSync(this.runtime, "utf8")).port !== port) {
        throw new Error("Stop your relay before changing its port");
      }
      return;
    }
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Own relay requires Node 22 or later");
    const log = openSync(join(this.root, "relay.log"), "a", 0o600);
    const instanceId = randomUUID();
    try {
      const child = spawn(process.execPath, [realpathSync(join(this.source, "src/node/server.js"))], {
        cwd: this.source, detached: true, stdio: ["ignore", log, log],
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1",
          RELAY_INSTANCE_ID: instanceId, DATABASE_PATH: join(this.root, "relay.sqlite3"),
          APNS_TEAM_ID: "", APNS_KEY_ID: "", APNS_PRIVATE_KEY: "" },
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve); child.once("error", reject);
      });
      child.unref();
      try {
        await waitForHealth(port, instanceId, () => child.exitCode !== null || child.signalCode !== null);
      } catch (error) {
        child.kill("SIGTERM");
        throw error;
      }
      writePrivateFile(this.runtime, JSON.stringify({ pid: child.pid, port }));
    } finally { closeSync(log); }
  }

  async stop(): Promise<void> {
    const pid = await this.ownedPID();
    if (pid !== null) process.kill(pid, "SIGTERM");
    // A stale or foreign PID is never signalled. Preserve its record for inspection.
    if (pid !== null) rmSync(this.runtime);
  }
}

async function waitForHealth(port: number, instanceId: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!exited() && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      const data = await response.json() as { ok?: boolean; instanceId?: string };
      if (response.ok && data.ok === true && data.instanceId === instanceId) return;
    } catch { /* a fresh child may not have bound its loopback socket yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Own relay failed its startup health check; check the port and relay log");
}
