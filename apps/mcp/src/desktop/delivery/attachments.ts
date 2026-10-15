import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { UserAttachment, MAX_USER_ATTACHMENTS } from "../../../../../packages/protocol/schema";

/** Read only a bounded private batch prepared by the same-user native client. */
type AttachmentLocations = { platform: string; temporary: string; home: string };

function allowedParent(parent: string, locations: AttachmentLocations): boolean {
  const roots = [locations.temporary];
  if (locations.platform === "darwin") roots.push(
    join(locations.temporary, "com.ziborov.granttap"),
    join(locations.home, "Library", "Containers", "com.ziborov.granttap", "Data", "tmp"),
  );
  return roots.some(root => {
    try { return parent === realpathSync(root); } catch { return false; }
  });
}

export function readDesktopAttachments(manifest: unknown, locations: AttachmentLocations = {
  platform: process.platform, temporary: tmpdir(), home: homedir(),
}): UserAttachment[] | undefined {
  if (manifest === undefined) return [];
  if (typeof manifest !== "string" || manifest.length > 32_768) return undefined;
  try {
    const rows: unknown = JSON.parse(manifest);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_USER_ATTACHMENTS) return undefined;
    let total = 0;
    const paths = new Set<string>();
    return rows.map((row: { name?: unknown; mimeType?: unknown; path?: unknown }) => {
      if (!row || typeof row.path !== "string" || row.path.length > 4_096
        || !/^[0-9]$/.test(basename(row.path)) || paths.has(row.path)) throw new Error("Invalid file");
      const directory = dirname(row.path);
      const parent = lstatSync(directory);
      if (!parent.isDirectory() || parent.uid !== process.getuid?.()
        || (parent.mode & 0o777) !== 0o700
        || !/^granttap-message-[A-Za-z0-9-]{6,64}$/.test(basename(directory))
        || !allowedParent(dirname(realpathSync(directory)), locations)) throw new Error("Invalid batch");
      paths.add(row.path);
      const fd = openSync(row.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        total += stat.size;
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
          || stat.size > 6_000_000 || total > 11_000_000) throw new Error("Invalid file size or access");
        const data = readFileSync(fd);
        if (data.length !== stat.size) throw new Error("File changed during read");
        return UserAttachment.parse({ name: row.name, mimeType: row.mimeType, data: data.toString("base64") });
      } finally { closeSync(fd); }
    });
  } catch { return undefined; }
}
