import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TomlTable } from 'smol-toml';

export function nativeFixture(root: string, record: TomlTable): string {
  mkdirSync(join(root, 'sqlite'), { recursive: true });
  const path = join(root, 'sqlite', 'codex-dev.db');
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY,name TEXT,prompt TEXT,status TEXT,
    rrule TEXT,created_at INTEGER,updated_at INTEGER,target_thread_id TEXT,kind TEXT,
    next_run_at INTEGER,next_run_nominal_at INTEGER,last_run_at INTEGER,model TEXT,
    account_id TEXT,user_id TEXT,installation_id TEXT,legacy_automation_id TEXT)`);
  database.prepare(`INSERT INTO automations (id,name,prompt,status,rrule,created_at,updated_at,
    target_thread_id,kind,next_run_at,next_run_nominal_at,model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(record.id), String(record.name), String(record.prompt), String(record.status),
      String(record.rrule), Number(record.created_at), Number(record.updated_at),
      String(record.target_thread_id), String(record.kind), 3_601_000, 3_601_000, 'retain-model');
  database.close();
  return path;
}
