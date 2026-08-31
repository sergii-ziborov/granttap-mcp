import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { configDir } from "../config/paths";
import { EngineClient } from "./engine-client";
import { engineHealth, type EngineHealth } from "./engine-health";
import { EngineProtocolError } from "./engine-protocol";

export type VerifiedEngineBinary = { path: string; sha256: string };

export type EngineClientLike = Pick<EngineClient, "request" | "close">;

export type EngineSupervisorOptions = {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  now?: () => number;
  client?: EngineClientLike;
  launch?: (path: string, socketPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
};

export function engineFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GRANTTAP_ENGINE_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function verifyEngineBinary(
  binaryPath: string,
  expectedSha256: string,
): Promise<VerifiedEngineBinary> {
  if (!isAbsolute(binaryPath)) throw new Error("engine binary path must be absolute");
  if (!/^[a-f\d]{64}$/i.test(expectedSha256)) throw new Error("engine checksum is invalid");
  const metadata = await lstat(binaryPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("engine binary must be a regular file");
  }
  await access(binaryPath, constants.X_OK);
  const sha256 = await fileSha256(binaryPath);
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error("engine binary checksum mismatch");
  return { path: binaryPath, sha256 };
}

export class EngineSupervisor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly client: EngineClientLike;
  private readonly launch: NonNullable<EngineSupervisorOptions["launch"]>;
  private child?: ChildProcess;
  private nextLaunchAt = 0;

  constructor(options: EngineSupervisorOptions = {}) {
    this.env = options.env ?? process.env;
    this.socketPath = options.socketPath ?? join(configDir(), "engine.sock");
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new EngineClient({ socketPath: this.socketPath });
    this.launch = options.launch ?? launchEngine;
  }

  async ensureAvailable(): Promise<EngineHealth> {
    if (!engineFeatureEnabled(this.env)) return engineHealth("disabled", {}, this.now());
    const existing = await this.ping();
    if (existing) return existing;
    if (this.now() < this.nextLaunchAt) {
      return engineHealth("backoff", { reason: "engine restart backoff is active" }, this.now());
    }
    const configured = configuredBinary(this.env);
    if (!configured) {
      return engineHealth("unavailable", { reason: "verified engine binary is not configured" }, this.now());
    }
    try {
      const binary = await verifyEngineBinary(configured.path, configured.sha256);
      this.child = this.launch(binary.path, this.socketPath, this.env);
      this.child.once("error", () => undefined);
      const health = await this.waitUntilHealthy();
      if (health) return health;
      this.stopChild();
      this.nextLaunchAt = this.now() + 1_000;
      return engineHealth("unavailable", { reason: "engine did not become healthy" }, this.now());
    } catch (error) {
      this.stopChild();
      this.nextLaunchAt = this.now() + 1_000;
      return engineHealth("unavailable", { reason: errorMessage(error) }, this.now());
    }
  }

  async stop(): Promise<void> {
    this.client.close();
    const child = this.child;
    this.child = undefined;
    if (child) await terminateChild(child);
  }

  private async ping(): Promise<EngineHealth | undefined> {
    try {
      const result = await this.client.request({ operation: "engine.ping" });
      if (result.operation !== "engine.pong") {
        return engineHealth("incompatible", { reason: "unexpected engine ping response" }, this.now());
      }
      return engineHealth("healthy", { engineVersion: result.engine_version }, this.now());
    } catch (error) {
      if (error instanceof EngineProtocolError) {
        return engineHealth("incompatible", { reason: error.message }, this.now());
      }
      return undefined;
    }
  }

  private async waitUntilHealthy(): Promise<EngineHealth | undefined> {
    for (const delayMs of [10, 20, 40, 80]) {
      await delay(delayMs);
      const health = await this.ping();
      if (health) return health;
    }
    return undefined;
  }

  private stopChild(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

function configuredBinary(env: NodeJS.ProcessEnv): VerifiedEngineBinary | undefined {
  const path = env.GRANTTAP_ENGINE_BINARY;
  const sha256 = env.GRANTTAP_ENGINE_SHA256;
  return path && sha256 ? { path, sha256 } : undefined;
}

function launchEngine(path: string, socketPath: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(path, [], {
    env: { ...env, GRANTTAP_ENGINE_SOCKET: socketPath },
    stdio: "ignore",
    shell: false,
  });
  child.unref();
  return child;
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    child.once("exit", finish);
    child.once("error", finish);
    if (!child.kill()) finish();
  });
}
