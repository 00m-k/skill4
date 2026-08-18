import assert from 'node:assert/strict';
import test from 'node:test';
import syncCore from './sync-core.js';

const { decodeEnvelope, emptyState, encodeEnvelope, GitHubContentsSyncClient, mergeState, migrateToSharedState, taskIdFor } = syncCore;

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

test('newest same-task update wins while unrelated updates survive', () => {
  const local = {
    ...emptyState(),
    tasks: {
      psychology: { done: true, updatedAt: '2026-08-18T10:00:00Z', source: 'web' },
    },
  };
  const remote = {
    ...emptyState(),
    revision: 4,
    tasks: {
      psychology: { done: false, updatedAt: '2026-08-18T11:00:00Z', source: 'companion' },
      statistics: { done: true, updatedAt: '2026-08-18T10:30:00Z', source: 'companion' },
    },
  };

  const merged = mergeState(local, remote);

  assert.equal(merged.revision, 4);
  assert.deepEqual(merged.tasks, remote.tasks);
});

test('encrypted envelope hides report text and round-trips the shared state', async () => {
  const state = {
    ...emptyState(),
    dailyReports: {
      '2026-08-18': {
        hours: '3.5',
        summary: '统计第5章做完了，但方差公式还不熟。',
        problem: '',
        tomorrow: '复习统计公式',
        updatedAt: '2026-08-18T14:30:00Z',
      },
    },
  };

  const envelope = await encodeEnvelope(state, KEY, globalThis.crypto);

  assert.equal(envelope.algorithm, 'A256GCM');
  assert.equal(JSON.stringify(envelope).includes('方差公式'), false);
  assert.deepEqual(await decodeEnvelope(envelope, KEY, globalThis.crypto), state);
});

test('pull treats a missing remote state as empty instead of losing local state', async () => {
  const client = new GitHubContentsSyncClient({
    fetchImpl: async () => new Response('', { status: 404 }),
    tokenProvider: () => 'local-token',
    crypto: globalThis.crypto,
  });

  const pulled = await client.pull(KEY);

  assert.deepEqual(pulled.state, emptyState());
  assert.equal(pulled.sha, null);
});

test('decodeEnvelope rejects a wrong key', async () => {
  const envelope = await encodeEnvelope(emptyState(), KEY, globalThis.crypto);
  const wrongKey = new Uint8Array(32); // 全零，非正确密钥
  await assert.rejects(decodeEnvelope(envelope, wrongKey, globalThis.crypto));
});

test('decodeEnvelope rejects tampered ciphertext', async () => {
  const envelope = await encodeEnvelope(emptyState(), KEY, globalThis.crypto);
  const last = envelope.ciphertext.endsWith('A') ? 'B' : 'A';
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + last };
  await assert.rejects(decodeEnvelope(tampered, KEY, globalThis.crypto));
});

test('push retries exactly once on 409, merging the pulled remote state', async () => {
  const remoteState = {
    ...emptyState(),
    revision: 2,
    tasks: {
      psychology: { done: true, updatedAt: '2026-08-18T12:00:00Z', source: 'web' },
    },
  };
  const remoteEnvelope = await encodeEnvelope(remoteState, KEY, globalThis.crypto);
  const remoteContent = Buffer.from(JSON.stringify(remoteEnvelope)).toString('base64');

  const localState = {
    ...emptyState(),
    revision: 1,
    tasks: {
      statistics: { done: true, updatedAt: '2026-08-18T11:00:00Z', source: 'companion' },
    },
  };

  let putCalls = 0;
  let pullCalls = 0;

  const fetchImpl = async (_url, opts) => {
    if (opts.method === 'PUT') {
      putCalls += 1;
      if (putCalls === 1) return new Response('', { status: 409 });
      return new Response(JSON.stringify({ content: remoteContent, sha: 'retry-sha' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    pullCalls += 1;
    return new Response(JSON.stringify({ content: remoteContent, sha: 'remote-sha' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = new GitHubContentsSyncClient({
    fetchImpl,
    tokenProvider: () => 'local-token',
    crypto: globalThis.crypto,
  });

  const result = await client.push(localState, 'stale-sha', KEY);

  assert.equal(putCalls, 2, '409 之后应重试恰好一次');
  assert.equal(pullCalls, 1, '重试前应拉取一次远程状态');
  assert.equal(result.state.tasks.psychology.done, true, '远程已有任务应保留');
  assert.equal(result.state.tasks.statistics.done, true, '本地新任务应保留');
  assert.equal(result.state.revision, 2);
  assert.equal(result.sha, 'retry-sha');
});

test('taskIdFor is deterministic and positional', () => {
  assert.equal(taskIdFor('2026-08-18', 3, 1, 0), '2026-08-18/w3/d1/i0');
  assert.equal(taskIdFor('2026-08-18', 3, 1, 0), taskIdFor('2026-08-18', 3, 1, 0));
  assert.notEqual(taskIdFor('2026-08-18', 3, 1, 0), taskIdFor('2026-08-18', 3, 1, 1));
});

test('migrateToSharedState moves legacy done texts and evening reports exactly once', () => {
  const planExport = [
    { id: '2026-08-18/w3/d1/i0', text: '📖普心第9章 新课', dateKey: '2026-08-18', week: 3, dow: 1, index: 0 },
    { id: '2026-08-18/w3/d1/i1', text: '🖊普心对应习题', dateKey: '2026-08-18', week: 3, dow: 1, index: 1 },
  ];
  const legacyDone = { '2026-08-18': ['📖普心第9章 新课'] };
  const legacyEvenings = {
    '2026-08-18': { hours: '3.5', summary: '统计第5章做完了', problem: '', tomorrow: '复习', savedAt: '2026-08-18T14:30:00Z' },
  };

  const state = migrateToSharedState(planExport, legacyDone, legacyEvenings, '2026-08-18T15:00:00Z');

  assert.equal(state.tasks['2026-08-18/w3/d1/i0'].done, true);
  assert.equal(state.tasks['2026-08-18/w3/d1/i1'], undefined, '未完成的任务不写入');
  assert.equal(state.dailyReports['2026-08-18'].summary, '统计第5章做完了');
  assert.equal(state.dailyReports['2026-08-18'].updatedAt, '2026-08-18T14:30:00Z');
});
