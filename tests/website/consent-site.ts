import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Small in-memory website contract for local MCP OAuth integration tests. */
export function listenConsentSite(): Promise<{
  origin: string;
  store: Map<string, Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const store = new Map<string, Record<string, unknown>>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const id = url.pathname.split("/")[4] ?? "";
    if (req.method === "PUT" && url.pathname.startsWith("/api/connect/requests/")) {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      store.set(id, { ...store.get(id), ...body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/redirect")) {
      const body = JSON.parse(await readBody(req)) as { redirectUrl?: string };
      store.set(id, { ...store.get(id), redirectUrl: body.redirectUrl });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/connect/requests/")) {
      const row = store.get(id);
      if (!row) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(row));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, store,
        close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
