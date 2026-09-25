import { createInterface } from "node:readline";
import { desktopTaskActivity } from "./task-activity";

process.stdout.write('{"ready":true}\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 8_192) continue;
  try {
    const request = JSON.parse(line) as { id: string; query: unknown; storePath?: string };
    const result = desktopTaskActivity(request.query, request.storePath) ?? null;
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch {
    process.stdout.write('{"id":null,"result":null}\n');
  }
}
