import { reloadMonitorHelper } from "../../../bridge/src/install";
import { relay } from "../mcp-tools/relay";

/**
 * A QR scan is Approve. The phone still needs this computer in the room
 * after the coding app takes its OAuth redirect. Wake the relay and leave
 * one held heartbeat so the app does not sit in an empty offline room.
 */
export function wakePairingRoomAfterApprove(
  approve: boolean,
  start: () => Promise<unknown> | unknown = relay,
): void {
  if (!approve) return;
  // The test runner keeps the process alive for open sockets. Production
  // still wakes the room; tests inject `start` when they want this path.
  if (start === relay && process.env.NODE_TEST_CONTEXT) return;
  // launchctl kickstart is spawnSync. Doing it inside /authorize blocks the
  // 302 Cursor is waiting on and leaves a blank localhost tab.
  const wake = (): void => {
    reloadMonitorHelper();
    void Promise.resolve(start()).then((client) => {
      if (client == null) {
        process.stderr.write("[granttap] pairing room wake did not connect\n");
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[granttap] pairing room wake failed: ${message}\n`);
    });
  };
  setImmediate(wake);
}
