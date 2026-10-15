import assert from 'node:assert/strict';
import test from 'node:test';
import { createHardwareSampler, parseNvidiaCapacity } from '../hardware';

test('host utilization requires two measured CPU samples and never treats an unknown sample as idle', async () => {
  let current = 0;
  const cpu = (idle: number, user: number) => [{ model: 'fixture', speed: 1, times: { idle, user, nice: 0, sys: 0, irq: 0 } }];
  const samples = [cpu(90, 10), cpu(150, 50), cpu(150, 50), cpu(1, 1)];
  const sample = createHardwareSampler({ cpus: () => samples[current++]!, memory: () => 8_000,
    disk: async () => ({ bsize: 4_096, bavail: 10 }), gpu: async () => undefined });
  assert.equal((await sample('/fixture')).cpuUtilization, undefined);
  const active = await sample('/fixture');
  assert.equal(active.cpuUtilization, 0.4);
  assert.equal(active.availableMemoryBytes, 8_000);
  assert.equal(active.availableDiskBytes, 40_960);
  assert.equal((await sample('/fixture')).cpuUtilization, undefined);
  assert.equal((await sample('/fixture')).cpuUtilization, undefined);
});

test('GPU selection reports positive free capacity on one NVIDIA device, without summing unrelated cards', () => {
  assert.deepEqual(parseNvidiaCapacity('NVIDIA RTX 4090, 12000\nNVIDIA RTX 3090, 16000\n'),
    { vendor: 'nvidia', available: true, memoryBytes: 16_000 * 1_024 * 1_024 });
  assert.equal(parseNvidiaCapacity('NVIDIA RTX, N/A'), undefined);
  assert.equal(parseNvidiaCapacity('NVIDIA RTX, -1'), undefined);
  assert.equal(parseNvidiaCapacity('NVIDIA RTX, 0'), undefined);
});
