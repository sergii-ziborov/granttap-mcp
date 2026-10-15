import { join } from 'node:path';
import { configDir } from '../../config/runtime/paths';
import { PreparedTaskTransfers } from '../index';

let current: { root: string; store: PreparedTaskTransfers } | undefined;
export function localTaskTransfers(): PreparedTaskTransfers {
  const root = join(configDir(), 'task-transfers');
  if (current?.root !== root) current = { root, store: new PreparedTaskTransfers(root) };
  return current.store;
}
