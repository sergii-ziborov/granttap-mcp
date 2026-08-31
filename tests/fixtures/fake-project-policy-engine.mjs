import { createServer } from "node:net";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("socket path is required");

const server = createServer((socket) => {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      const result = responseFor(request);
      const payload = Buffer.from(JSON.stringify({
        protocol_version: 1,
        request_id: request.request_id,
        status: "ok",
        result,
      }));
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame);
    }
  });
});

server.listen(socketPath, () => process.stdout.write("ready\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

function responseFor(request) {
  if (request.operation === "project.resolve") {
    return {
      operation: "project.resolved",
      resolution: { project_id: "project", compatibility_mode: false },
    };
  }
  if (request.operation !== "policy.evaluate_action") throw new Error("unexpected operation");
  const kind = request.input?.capability?.kind;
  const effect = kind === "file_write" || kind === "mcp"
    ? "deny"
    : kind === "shell"
      ? "ask"
      : "allow";
  return {
    operation: "policy.evaluated",
    decision: {
      effect,
      source: "project",
      reason: `Project test policy requires ${effect}`,
      rule_id: `${effect}-${kind}`,
      policy_revision: 1,
    },
  };
}
