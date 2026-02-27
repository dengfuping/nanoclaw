import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { NewMessage } from '../types.js';
import type { ISearchService, SearchResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello world',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. NoopSearchService
// ---------------------------------------------------------------------------

describe('NoopSearchService', () => {
  let noop: ISearchService;

  beforeEach(async () => {
    const { NoopSearchService } = await import('./noop-search.js');
    noop = new NoopSearchService();
  });

  it('init and close are no-ops', async () => {
    await expect(noop.init()).resolves.toBeUndefined();
    await expect(noop.close()).resolves.toBeUndefined();
  });

  it('indexMessage is a no-op', async () => {
    await expect(noop.indexMessage(makeMsg())).resolves.toBeUndefined();
  });

  it('indexMessageBatch is a no-op', async () => {
    await expect(
      noop.indexMessageBatch([makeMsg(), makeMsg({ id: 'msg-2' })]),
    ).resolves.toBeUndefined();
  });

  it('searchMessages always returns empty array', async () => {
    const results = await noop.searchMessages('anything');
    expect(results).toEqual([]);
  });

  it('searchMessages with options still returns empty', async () => {
    const results = await noop.searchMessages('test', {
      chatJid: 'group@g.us',
      limit: 5,
      timeDecay: true,
    });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. SeekdbSearchService (inject mock collection directly)
// ---------------------------------------------------------------------------

describe('SeekdbSearchService', () => {
  const mockAdd = vi.fn().mockResolvedValue(undefined);
  const mockQuery = vi.fn();
  const mockHybridSearch = vi.fn();
  const mockCount = vi.fn().mockResolvedValue(0);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreateDatabase = vi.fn().mockResolvedValue(undefined);

  const mockCollection = {
    add: mockAdd,
    query: mockQuery,
    hybridSearch: mockHybridSearch,
    count: mockCount,
  };

  const mockClient = {
    getOrCreateCollection: vi.fn().mockResolvedValue(mockCollection),
    createDatabase: mockCreateDatabase,
    close: mockClose,
  };

  let SeekdbSearchService: (typeof import('./seekdb-search.js'))['SeekdbSearchService'];

  function createTestService() {
    const svc = new SeekdbSearchService({});
    const internal = svc as unknown as Record<string, unknown>;
    internal.client = mockClient;
    internal.collection = mockCollection;
    return svc;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ SeekdbSearchService } = await import('./seekdb-search.js'));
  });

  // -- Indexing --

  it('indexMessage calls collection.add with correct shape', async () => {
    const svc = createTestService();
    const msg = makeMsg({
      id: 'idx-1',
      sender_name: 'Bob',
      content: 'test msg',
    });

    await svc.indexMessage(msg);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const arg = mockAdd.mock.calls[0][0] as {
      ids: string;
      documents: string;
      metadatas: Record<string, unknown>;
    };
    expect(arg.ids).toBe('idx-1');
    expect(arg.documents).toBe('Bob: test msg');
    expect(arg.metadatas).toMatchObject({
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'Bob',
      is_from_me: false,
    });
  });

  it('indexMessage defaults is_from_me to false when undefined', async () => {
    const svc = createTestService();
    await svc.indexMessage(makeMsg({ is_from_me: undefined }));

    const meta = (
      mockAdd.mock.calls[0][0] as { metadatas: Record<string, unknown> }
    ).metadatas;
    expect(meta.is_from_me).toBe(false);
  });

  it('indexMessage sets is_from_me true when provided', async () => {
    const svc = createTestService();
    await svc.indexMessage(makeMsg({ is_from_me: true }));

    const meta = (
      mockAdd.mock.calls[0][0] as { metadatas: Record<string, unknown> }
    ).metadatas;
    expect(meta.is_from_me).toBe(true);
  });

  it('indexMessage swallows add errors gracefully', async () => {
    mockAdd.mockRejectedValueOnce(new Error('db error'));
    const svc = createTestService();

    await expect(svc.indexMessage(makeMsg())).resolves.toBeUndefined();
  });

  it('indexMessageBatch sends all messages in one add call', async () => {
    const svc = createTestService();
    const msgs = [
      makeMsg({ id: 'm1', content: 'one' }),
      makeMsg({ id: 'm2', content: 'two', sender_name: 'Bob' }),
    ];

    await svc.indexMessageBatch(msgs);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const arg = mockAdd.mock.calls[0][0] as {
      ids: string[];
      documents: string[];
      metadatas: Record<string, unknown>[];
    };
    expect(arg.ids).toEqual(['m1', 'm2']);
    expect(arg.documents).toEqual(['Alice: one', 'Bob: two']);
    expect(arg.metadatas).toHaveLength(2);
  });

  it('indexMessageBatch skips empty array without calling add', async () => {
    const svc = createTestService();
    await svc.indexMessageBatch([]);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('indexMessageBatch swallows errors gracefully', async () => {
    mockAdd.mockRejectedValueOnce(new Error('batch error'));
    const svc = createTestService();

    await expect(svc.indexMessageBatch([makeMsg()])).resolves.toBeUndefined();
  });

  // -- Search: 3-tier fallback --

  it('returns hybrid results when tier 1 succeeds', async () => {
    const now = new Date().toISOString();
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1', 'r2']],
      documents: [['Alice: hi', 'Bob: hey']],
      metadatas: [
        [
          {
            chat_jid: 'g@g.us',
            sender: 'a',
            sender_name: 'Alice',
            timestamp: now,
          },
          {
            chat_jid: 'g@g.us',
            sender: 'b',
            sender_name: 'Bob',
            timestamp: now,
          },
        ],
      ],
      distances: [[0.2, 0.4]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('greeting');

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('r1');
    expect(results[0].score).toBeCloseTo(0.8);
    expect(results[1].id).toBe('r2');
    expect(results[1].score).toBeCloseTo(0.6);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('falls back to tier 2 (vector) when hybrid throws', async () => {
    mockHybridSearch.mockRejectedValueOnce(new Error('hybrid not supported'));
    const now = new Date().toISOString();
    mockQuery.mockResolvedValueOnce({
      ids: [['v1']],
      documents: [['Alice: vector result']],
      metadatas: [
        [
          {
            chat_jid: 'g@g.us',
            sender: 'a',
            sender_name: 'Alice',
            timestamp: now,
          },
        ],
      ],
      distances: [[0.3]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('v1');
    expect(results[0].score).toBeCloseTo(0.7);
  });

  it('falls back to tier 2 when hybrid returns empty results', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [[]],
      documents: [[]],
      metadatas: [[]],
      distances: [[]],
    });
    const now = new Date().toISOString();
    mockQuery.mockResolvedValueOnce({
      ids: [['v1']],
      documents: [['content']],
      metadatas: [
        [{ chat_jid: 'g', sender: 's', sender_name: 'S', timestamp: now }],
      ],
      distances: [[0.1]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test');

    expect(results).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('returns empty array when all tiers fail (tier 3)', async () => {
    mockHybridSearch.mockRejectedValueOnce(new Error('fail'));
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const svc = createTestService();
    const results = await svc.searchMessages('nothing');

    expect(results).toEqual([]);
  });

  it('passes chatJid as where filter to both search tiers', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g@g.us',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.2]],
    });

    const svc = createTestService();
    await svc.searchMessages('test', { chatJid: 'group@g.us' });

    const hybridArgs = mockHybridSearch.mock.calls[0][0];
    expect(hybridArgs.query.where).toEqual({ chat_jid: 'group@g.us' });
    expect(hybridArgs.knn.where).toEqual({ chat_jid: 'group@g.us' });
  });

  it('omits where filter when chatJid is not provided', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.2]],
    });

    const svc = createTestService();
    await svc.searchMessages('test');

    const hybridArgs = mockHybridSearch.mock.calls[0][0];
    expect(hybridArgs.query.where).toBeUndefined();
    expect(hybridArgs.knn.where).toBeUndefined();
  });

  it('respects limit option (nResults and oversampling)', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.2]],
    });

    const svc = createTestService();
    await svc.searchMessages('test', { limit: 5 });

    const args = mockHybridSearch.mock.calls[0][0];
    expect(args.nResults).toBe(5);
    expect(args.query.nResults).toBe(10);
    expect(args.knn.nResults).toBe(10);
  });

  it('uses default limit of 10 when not specified', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.2]],
    });

    const svc = createTestService();
    await svc.searchMessages('test');

    expect(mockHybridSearch.mock.calls[0][0].nResults).toBe(10);
  });

  // -- Time decay --

  it('applies time decay — recent messages rank higher', async () => {
    const oldTime = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const recentTime = new Date(Date.now() - 1 * 3_600_000).toISOString();

    mockHybridSearch.mockResolvedValueOnce({
      ids: [['old', 'recent']],
      documents: [['old msg', 'recent msg']],
      metadatas: [
        [
          { chat_jid: 'g', sender: 's', sender_name: 'S', timestamp: oldTime },
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: recentTime,
          },
        ],
      ],
      // Same distance = same base relevance
      distances: [[0.2, 0.2]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test', { timeDecay: true });

    expect(results).toHaveLength(2);
    expect(results[0].timeWeight).toBeDefined();
    expect(results[1].timeWeight).toBeDefined();
    // Recent message should rank higher after time decay
    expect(results[0].id).toBe('recent');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    // Time weight for recent should be closer to 1
    expect(results[0].timeWeight!).toBeGreaterThan(results[1].timeWeight!);
  });

  it('does not apply time decay by default', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.3]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test');

    expect(results[0].timeWeight).toBeUndefined();
  });

  // -- formatResults edge cases --

  it('handles null metadata and documents gracefully', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [[null]],
      metadatas: [[null]],
      distances: [[null]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('');
    expect(results[0].metadata.chat_jid).toBe('');
    expect(results[0].metadata.sender_name).toBe('');
    expect(results[0].score).toBe(0);
  });

  it('computes score as 1 - distance', async () => {
    mockHybridSearch.mockResolvedValueOnce({
      ids: [['r1']],
      documents: [['content']],
      metadatas: [
        [
          {
            chat_jid: 'g',
            sender: 's',
            sender_name: 'S',
            timestamp: new Date().toISOString(),
          },
        ],
      ],
      distances: [[0.15]],
    });

    const svc = createTestService();
    const results = await svc.searchMessages('test');

    expect(results[0].score).toBeCloseTo(0.85);
  });

  it('close delegates to client.close', async () => {
    const svc = createTestService();
    await svc.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. search/index.ts — factory + batch queue
// ---------------------------------------------------------------------------

describe('search/index factory', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('creates NoopSearchService when DB_TYPE is sqlite', async () => {
    process.env.DB_TYPE = 'sqlite';
    delete process.env.SEARCH_ENABLED;

    const mod = await import('./index.js');
    await mod.initSearchService();
    const svc = mod.getSearchService();

    const results = await svc.searchMessages('test');
    expect(results).toEqual([]);
  });

  it('creates NoopSearchService when SEARCH_ENABLED=false overrides seekdb', async () => {
    process.env.DB_TYPE = 'seekdb';
    process.env.SEARCH_ENABLED = 'false';

    const mod = await import('./index.js');
    await mod.initSearchService();
    const svc = mod.getSearchService();

    const results = await svc.searchMessages('test');
    expect(results).toEqual([]);
  });
});

describe('search/index batch queue', () => {
  let mockService: ISearchService;

  beforeEach(async () => {
    vi.useFakeTimers();
    process.env.DB_TYPE = 'sqlite';

    const mod = await import('./index.js');
    await mod.initSearchService();
    mockService = mod.getSearchService();
    vi.spyOn(mockService, 'indexMessageBatch');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flushes batch after FLUSH_INTERVAL (5s)', async () => {
    const mod = await import('./index.js');

    mod.enqueueForIndexing(makeMsg({ id: 'q1' }));
    mod.enqueueForIndexing(makeMsg({ id: 'q2' }));

    expect(mockService.indexMessageBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(mockService.indexMessageBatch).toHaveBeenCalledTimes(1);
    const batch = (mockService.indexMessageBatch as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch[0].id).toBe('q1');
    expect(batch[1].id).toBe('q2');
  });

  it('closeSearchService flushes remaining queue', async () => {
    const mod = await import('./index.js');

    mod.enqueueForIndexing(makeMsg({ id: 'close-1' }));
    await mod.closeSearchService();

    expect(mockService.indexMessageBatch).toHaveBeenCalledTimes(1);
    const batch = (mockService.indexMessageBatch as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe('close-1');
  });

  it('size-based flush dispatches immediately at FLUSH_SIZE (50)', async () => {
    const mod = await import('./index.js');

    for (let i = 0; i < 50; i++) {
      mod.enqueueForIndexing(makeMsg({ id: `bulk-${i}` }));
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(mockService.indexMessageBatch).toHaveBeenCalledTimes(1);
    expect(
      (mockService.indexMessageBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toHaveLength(50);
  });

  it('multiple timer flushes accumulate independently', async () => {
    const mod = await import('./index.js');

    mod.enqueueForIndexing(makeMsg({ id: 'r1-1' }));
    mod.enqueueForIndexing(makeMsg({ id: 'r1-2' }));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(mockService.indexMessageBatch).toHaveBeenCalledTimes(1);
    expect(
      (mockService.indexMessageBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toHaveLength(2);

    mod.enqueueForIndexing(makeMsg({ id: 'r2-1' }));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(mockService.indexMessageBatch).toHaveBeenCalledTimes(2);
    const secondBatch = (
      mockService.indexMessageBatch as ReturnType<typeof vi.fn>
    ).mock.calls[1][0];
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].id).toBe('r2-1');
  });
});

// ---------------------------------------------------------------------------
// 4. Service lifecycle (DI-based, no module mocking)
// ---------------------------------------------------------------------------

describe('search service lifecycle', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('seekdb fallback: bad config falls back to noop', async () => {
    process.env.DB_TYPE = 'seekdb';
    process.env.SEARCH_ENABLED = 'true';
    process.env.SEEKDB_HOST = 'invalid-host-that-does-not-exist';
    process.env.SEEKDB_DATABASE = 'nonexistent_db';

    const mod = await import('./index.js');
    await mod.initSearchService();
    const svc = mod.getSearchService();

    const results = await svc.searchMessages('test');
    expect(results).toEqual([]);

    await mod.closeSearchService();
  });

  it('_setServiceForTesting replaces the active service', async () => {
    process.env.DB_TYPE = 'sqlite';
    const mod = await import('./index.js');
    await mod.initSearchService();

    const { NoopSearchService } = await import('./noop-search.js');
    const custom = new NoopSearchService();
    mod._setServiceForTesting(custom);
    expect(mod.getSearchService()).toBe(custom);

    await mod.closeSearchService();
  });

  it('_resetForTesting clears batch queue state', async () => {
    vi.useFakeTimers();
    process.env.DB_TYPE = 'sqlite';

    const mod = await import('./index.js');
    await mod.initSearchService();

    mod.enqueueForIndexing(makeMsg({ id: 'orphan' }));
    mod._resetForTesting();

    const svc = mod.getSearchService();
    const spy = vi.spyOn(svc, 'indexMessageBatch');

    // Advance past flush interval — nothing should flush because queue was reset
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spy).not.toHaveBeenCalled();

    vi.useRealTimers();
    await mod.closeSearchService();
  });
});
