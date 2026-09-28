import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const childPath = fileURLToPath(new URL("./bridge-child.ts", import.meta.url));

/** Run desktop reads away from the monitor's synchronous provider scans. */
export async function startDesktopEngineBridgeProcess(options: {
  onPairingChanged?: () => void;
} = {}): Promise<{
  socketPath: string;
  close: () => Promise<void>;
}> {
  const child = fork(childPath, [], {
    execArgv: [
      "--require", requireFromHere.resolve("tsx/preflight"),
      "--import", pathToFileURL(requireFromHere.resolve("tsx")).href,
    ],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object"
      && (message as { type?: string }).type === "pairing-changed") options.onPairingChanged?.();
  });
  const socketPath = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Desktop bridge did not start"));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Desktop bridge exited before it was ready"));
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object"
          || (message as { type?: string }).type !== "ready"
          || typeof (message as { socketPath?: unknown }).socketPath !== "string") return;
      cleanup();
      resolve((message as { socketPath: string }).socketPath);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
  return {
    socketPath,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.send({ type: "close" });
      });
    },
  };
}
