import { startDesktopEngineBridge } from "../engine-bridge";

let closing = false;
const bridge = await startDesktopEngineBridge();
process.send?.({ type: "ready", socketPath: bridge.socketPath });

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await bridge.close();
  process.exit(0);
}

process.on("message", (message) => {
  if (message && typeof message === "object"
      && (message as { type?: string }).type === "close") void close();
});
process.on("disconnect", () => { void close(); });
