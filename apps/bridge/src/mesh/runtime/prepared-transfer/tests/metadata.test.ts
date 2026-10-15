import assert from 'node:assert/strict';
import test from 'node:test';
import { preparedHandoffMetadata } from '../index';
import { networkFixture } from '../../../../task-network/tests/fixture';

test('prepared transfer notifications carry capsule evidence without copying the conversation into phone routing', () => {
  const f = networkFixture();
  try {
    const full = f.job.operation.event;
    const metadata = preparedHandoffMetadata(full);
    assert.equal(metadata.payload.transferContext, undefined);
    assert.equal(metadata.payload.capsule?.contextHash, full.payload.capsule?.contextHash);
    assert.ok(full.payload.transferContext, 'The machine transport retains its complete original context.');
    assert.ok(!JSON.stringify(metadata).includes(full.payload.transferContext!));
  } finally { f.cleanup(); }
});
