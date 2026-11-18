import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { priorityControlPayload } from '..';

/** Every message type the protocol defines as an answer, read from the schema sources. */
function answerTypes(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : answerTypes(path);
    if (!name.endsWith('.ts')) return [];
    return [...readFileSync(path, 'utf8').matchAll(/z\.literal\('([a-z.]+\.result)'\)/g)].flatMap(match => match[1] ? [match[1]] : []);
  });
}

test('every answer a phone waits on travels ahead of replaceable snapshots, as the phones list on a busy Mac', () => {
  // A Mesh Task's result goes from computer to computer over its own transport, never to a phone.
  const answers = [...new Set(answerTypes(join(dirname(fileURLToPath(import.meta.url)), '../../../protocol')))]
    .filter(type => type !== 'mesh.task.result').sort();
  assert.ok(answers.includes('device.manage.result') && answers.length >= 5, answers.join(', '));
  for (const type of answers) assert.equal(priorityControlPayload(type as never), true, type);
  for (const type of ['session.activity', 'sessions.snapshot', 'machine.load'] as const) {
    assert.equal(priorityControlPayload(type as never), false, type);
  }
});
