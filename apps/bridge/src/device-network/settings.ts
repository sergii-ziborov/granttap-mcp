import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

export type NetworkSettings = {
  mode: "managed" | "direct" | "selfHosted";
  endpoint: string;
  port: number;
};

const settingsPath = () => join(configDir(), "device-network.json");
const defaultSettings: NetworkSettings = { mode: "managed", endpoint: "", port: 3201 };

export function normalizeNetworkEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
    || url.username || url.password || url.search || url.hash || value.length > 2_048) {
    throw new Error("A TLS WebSocket endpoint without credentials, query or fragment is required");
  }
  return url.href.replace(/\/$/, "");
}

export function validateNetworkSettings(value: unknown): NetworkSettings {
  const input = value as Partial<NetworkSettings>;
  if (!input || !["managed", "direct", "selfHosted"].includes(input.mode ?? "")
    || !Number.isInteger(input.port) || input.port! < 1 || input.port! > 65_535
    || typeof input.endpoint !== "string") throw new Error("Invalid device network settings");
  return { mode: input.mode!, port: input.port!,
    endpoint: input.mode === "managed" ? "" : normalizeNetworkEndpoint(input.endpoint) };
}

export function readNetworkSettings(path = settingsPath()): NetworkSettings {
  if (!existsSync(path)) return { ...defaultSettings };
  return validateNetworkSettings(JSON.parse(readFileSync(path, "utf8")));
}

export function writeNetworkSettings(value: unknown, path = settingsPath()): NetworkSettings {
  const settings = validateNetworkSettings(value);
  writePrivateFile(path, JSON.stringify(settings, null, 2));
  return settings;
}

/** Routing overlays pairing material; never overwrite room identity or key halves. */
export function applyNetworkRoute(config: PeerConfig, path = settingsPath()): PeerConfig {
  const settings = readNetworkSettings(path);
  if (settings.mode === "managed") return config;
  return { ...config, relayUrl: settings.endpoint,
    directoryUrl: settings.mode === "direct" ? config.directoryUrl ?? config.relayUrl : undefined };
}
