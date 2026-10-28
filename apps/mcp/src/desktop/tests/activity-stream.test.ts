import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DesktopTaskActivityRunner } from '../task-activity-runner';

test('native activity preserves Cyrillic and emoji split between worker output chunks', async t => {
  const worker = fileURLToPath(new URL('./activity-stream-worker.cjs', import.meta.url));
  const runner = new DesktopTaskActivityRunner(() => spawn(process.execPath, [worker], { stdio: 'pipe' }));
  t.after(() => runner.close());
  const activity = await runner.read({ project_id: 'fixture-project', task_id: 'fixture-task' }) as any;
  assert.equal(activity?.entries?.[0]?.text, 'Привет 👋');
  const second = await runner.read({ project_id: 'fixture-project', task_id: 'fixture-task' }) as any;
  assert.equal(second?.entries?.[0]?.text, 'Привет 👋');
});
