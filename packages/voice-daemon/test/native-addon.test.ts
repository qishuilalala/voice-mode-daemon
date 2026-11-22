import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('sherpa-onnx-node native N-API binary smoke test', () => {
  it('loads native OfflineTts, OfflineRecognizer, and OnlineRecognizer constructors', async () => {
    const mod = await import('sherpa-onnx-node');
    const sherpa = 'default' in mod ? (mod.default as typeof mod) : mod;
    assert.equal(typeof sherpa.OfflineTts, 'function');
    assert.equal(typeof sherpa.OfflineRecognizer, 'function');
    assert.equal(typeof sherpa.OnlineRecognizer, 'function');
  });
});
