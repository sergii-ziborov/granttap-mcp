import { OwnRelay } from "../../../../bridge/src/device-network/own-relay";
import { readNetworkSettings, writeNetworkSettings } from "../../../../bridge/src/device-network/settings";
import { reloadMonitorHelper } from "../../../../bridge/src/install";

/** Same-user desktop administrative surface; never exposed as a remote provider tool. */
export class DesktopNetworkController {
  constructor(private readonly relay = new OwnRelay(), private readonly changed: () => void = () => {}) {}

  async read(operation: string, input: unknown): Promise<unknown> {
    const request = input as Record<string, unknown> | undefined;
    if (operation === "desktop.network_configure") {
      const settings = writeNetworkSettings({ mode: request?.mode,
        endpoint: request?.endpoint, port: Number(request?.port) });
      reloadMonitorHelper();
      this.changed();
      return { operation, settings, ownRelay: await this.relay.status() };
    }
    if (operation === "desktop.own_relay") {
      switch (request?.action) {
        case "install": await this.relay.install(); break;
        case "start": await this.relay.start(readNetworkSettings().port); break;
        case "stop": await this.relay.stop(); break;
        default: throw new Error("Choose install, start or stop for your own relay");
      }
    } else if (operation !== "desktop.network_status") return undefined;
    return { operation, settings: readNetworkSettings(), ownRelay: await this.relay.status() };
  }
}
