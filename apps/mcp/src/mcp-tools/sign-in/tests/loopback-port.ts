import { createServer, type AddressInfo, type Server } from "node:net";

/**
 * A port number nothing listens on: not on the wildcard address, and not on either loopback address.
 *
 * The system gives a port to a listener by looking at the one address it binds, so a server on `::1`
 * can be handed a number another program already holds on `127.0.0.1`. A replay tries `127.0.0.1`
 * before `::1`; a test that expects one of them to be empty would then reach that other program
 * instead, fail by chance, and send it a request that was never meant for it.
 */
export async function unusedLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const anywhere = await listening(0, undefined);
    if (!anywhere || anywhere === "in_use") continue;
    const port = (anywhere.address() as AddressInfo).port;
    await closed(anywhere);
    const held: Server[] = [];
    let free = true;
    for (const host of ["127.0.0.1", "::1"]) {
      const server = await listening(port, host);
      if (server === "in_use") { free = false; break; }
      if (server) held.push(server);
    }
    await Promise.all(held.map(closed));
    if (free) return port;
  }
  throw new Error("no port is free on both loopback addresses");
}

/** The listening server; "in_use" when another socket holds the address; nothing when the host has no such address. */
function listening(port: number, host: string | undefined): Promise<Server | "in_use" | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE" ? "in_use" : undefined));
    server.listen(port, host, () => resolve(server));
  });
}

function closed(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
