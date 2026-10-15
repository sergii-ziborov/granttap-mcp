import { cpus, freemem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export type HardwareCapacity = { cpuUtilization?: number; availableMemoryBytes?: number;
  availableDiskBytes?: number; gpu?: { vendor: string; available: boolean; memoryBytes?: number } };
type Readers = { cpus: typeof cpus; memory: () => number;
  disk: (path: string) => Promise<{ bsize: number; bavail: number }>;
  gpu: () => Promise<HardwareCapacity['gpu']> };

export function parseNvidiaCapacity(output: string): HardwareCapacity['gpu'] {
  const capacities = output.split('\n').slice(0, 16).flatMap(line => {
    const [name, available, ...extra] = line.split(',').map(value => value.trim());
    const memory = Number(available);
    return !extra.length && name?.startsWith('NVIDIA ') && available
      && Number.isSafeInteger(memory) && memory > 0 && memory < 10_000_000 ? [memory] : [];
  });
  return capacities.length ? { vendor: 'nvidia', available: true,
    memoryBytes: Math.max(...capacities) * 1_024 * 1_024 } : undefined;
}

function nvidiaCapacity(): Promise<HardwareCapacity['gpu']> {
  return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=name,memory.free', '--format=csv,noheader,nounits'],
    { timeout: 2_000, maxBuffer: 16_000, windowsHide: true },
    (error, output) => resolve(error ? undefined : parseNvidiaCapacity(output))));
}

function counters(rows: ReturnType<typeof cpus>) {
  if (!rows.length) return undefined;
  let total = 0, idle = 0;
  for (const row of rows) {
    const values = Object.values(row.times);
    if (values.some(value => !Number.isFinite(value) || value < 0)) return undefined;
    total += values.reduce((sum, value) => sum + value, 0); idle += row.times.idle;
  }
  return { total, idle, count: rows.length };
}

/** Measures host capacity without reading prompts, credentials, process arguments or model data. */
export function createHardwareSampler(readers: Readers = { cpus, memory: freemem, disk: statfs, gpu: nvidiaCapacity }) {
  let previous: ReturnType<typeof counters>;
  return async (workspace: string): Promise<HardwareCapacity> => {
    const current = counters(readers.cpus());
    const elapsed = current && previous && current.count === previous.count ? current.total - previous.total : 0;
    const idle = current && previous ? current.idle - previous.idle : -1;
    const cpuUtilization = elapsed > 0 && idle >= 0 && idle <= elapsed ? 1 - idle / elapsed : undefined;
    previous = current;
    const memory = readers.memory();
    const [disk, gpu] = await Promise.allSettled([readers.disk(workspace), readers.gpu()]);
    const freeDisk = disk.status === 'fulfilled' ? disk.value.bsize * disk.value.bavail : undefined;
    return { ...(cpuUtilization != null ? { cpuUtilization } : {}),
      ...(Number.isSafeInteger(memory) && memory >= 0 ? { availableMemoryBytes: memory } : {}),
      ...(freeDisk != null && Number.isSafeInteger(freeDisk) && freeDisk >= 0 ? { availableDiskBytes: freeDisk } : {}),
      ...(gpu.status === 'fulfilled' && gpu.value ? { gpu: gpu.value } : {}) };
  };
}
