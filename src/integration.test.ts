/**
 * End-to-end integration test for the database adapter and search subsystem.
 *
 * Runs the SAME test suite against both SQLite and seekdb:
 *   - SQLite: always runs (no external dependencies)
 *   - seekdb: runs in embedded mode (uses temp dir, no server needed)
 *
 * Each DB type gets its own temp directory, fresh module imports
 * (via vi.resetModules), and full lifecycle (init → test → close).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type DbModule = typeof import('./db/index.js');
type SearchModule = typeof import('./search/index.js');
type IpcModule = typeof import('./ipc.js');
type NoopModule = typeof import('./search/noop-search.js');

/**
 * Defines the full adapter + search test suite. Called once per DB type.
 * Must be invoked inside a describe() block.
 */
function defineAdapterSuite(dbType: 'sqlite' | 'seekdb') {
  let tempDir: string;
  let db: DbModule;
  let search: SearchModule;
  let ipc: IpcModule;
  let noopMod: NoopModule;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nanoclaw-${dbType}-`));

    vi.resetModules();

    if (dbType === 'seekdb') {
      process.env.DB_TYPE = 'seekdb';
      process.env.SEEKDB_PATH = tempDir;
      process.env.SEEKDB_DATABASE = 'nanoclaw_integration';
    } else {
      process.env.DB_TYPE = 'sqlite';
      process.env.STORE_DIR = tempDir;
    }

    db = await import('./db/index.js');
    search = await import('./search/index.js');
    ipc = await import('./ipc.js');
    noopMod = await import('./search/noop-search.js');

    await db.initDatabase();
  });

  afterAll(async () => {
    try {
      await search.closeSearchService();
    } catch {}
    try {
      await db.closeDatabase();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  // ------------------------------------------------------------------
  // Database adapter
  // ------------------------------------------------------------------

  it('stores and retrieves chats', async () => {
    await db.storeChatMetadata(
      'test-group@g.us',
      '2025-01-01T00:00:00.000Z',
      'Test Group',
      'whatsapp',
      true,
    );
    await db.storeChatMetadata(
      'test-dm@s.whatsapp.net',
      '2025-01-01T00:00:01.000Z',
      undefined,
      'whatsapp',
      false,
    );
    await db.updateChatName('test-group@g.us', 'Updated Group');

    const chats = await db.getAllChats();
    expect(chats).toHaveLength(2);
    expect(chats.find((c) => c.jid === 'test-group@g.us')?.name).toBe(
      'Updated Group',
    );

    expect(await db.getLastGroupSync()).toBeNull();
    await db.setLastGroupSync();
    expect(await db.getLastGroupSync()).not.toBeNull();
  });

  it('stores and queries messages', async () => {
    await db.storeMessage({
      id: 'msg-1',
      chat_jid: 'test-group@g.us',
      sender: 'user1@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'Hello world',
      timestamp: '2025-01-01T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await db.storeMessageDirect({
      id: 'msg-2',
      chat_jid: 'test-group@g.us',
      sender: 'user2@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'Hi there',
      timestamp: '2025-01-01T00:00:03.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await db.storeMessage({
      id: 'msg-bot',
      chat_jid: 'test-group@g.us',
      sender: 'bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Bot reply',
      timestamp: '2025-01-01T00:00:04.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const since = await db.getMessagesSince(
      'test-group@g.us',
      '2025-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(since).toHaveLength(2);
    expect(since[0].content).toBe('Hello world');

    const { messages, newTimestamp } = await db.getNewMessages(
      ['test-group@g.us'],
      '2025-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(2);
    expect(newTimestamp).toBe('2025-01-01T00:00:03.000Z');

    const empty = await db.getNewMessages([], '', 'Andy');
    expect(empty.messages).toHaveLength(0);
  });

  it('manages tasks lifecycle', async () => {
    await db.createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'test-group@g.us',
      prompt: 'Say hello',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const task = await db.getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('Say hello');
    expect(await db.getTasksForGroup('main')).toHaveLength(1);
    expect(await db.getAllTasks()).toHaveLength(1);

    await db.updateTask('task-1', { status: 'paused' });
    expect((await db.getTaskById('task-1'))!.status).toBe('paused');
    await db.updateTask('task-1', { status: 'active' });

    await db.createTask({
      id: 'task-due',
      group_folder: 'main',
      chat_jid: 'test-group@g.us',
      prompt: 'Due task',
      schedule_type: 'once',
      schedule_value: '2020-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    expect((await db.getDueTasks()).length).toBeGreaterThanOrEqual(1);

    await db.updateTaskAfterRun('task-due', null, 'Done');
    expect((await db.getTaskById('task-due'))!.status).toBe('completed');

    await db.logTaskRun({
      task_id: 'task-1',
      run_at: '2025-01-01T00:01:00.000Z',
      duration_ms: 1500,
      status: 'success',
      result: 'ok',
      error: null,
    });

    await db.deleteTask('task-1');
    expect(await db.getTaskById('task-1')).toBeUndefined();
  });

  it('stores and retrieves router state', async () => {
    expect(await db.getRouterState('test_key')).toBeUndefined();
    await db.setRouterState('test_key', 'test_value');
    expect(await db.getRouterState('test_key')).toBe('test_value');
  });

  it('manages sessions', async () => {
    expect(await db.getSession('main')).toBeUndefined();

    await db.setSession('main', 'sess-abc-123');
    expect(await db.getSession('main')).toBe('sess-abc-123');

    await db.setSession('other', 'sess-xyz-789');
    const all = await db.getAllSessions();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['main']).toBe('sess-abc-123');
  });

  it('manages registered groups', async () => {
    await db.setRegisteredGroup('verify@g.us', {
      name: 'Verify Group',
      folder: 'verify',
      trigger: '@Bot',
      added_at: '2025-01-01T00:00:00.000Z',
      requiresTrigger: true,
    });

    const rg = await db.getRegisteredGroup('verify@g.us');
    expect(rg).toBeDefined();
    expect(rg!.name).toBe('Verify Group');
    expect(rg!.trigger).toBe('@Bot');
    expect(rg!.requiresTrigger).toBe(true);

    expect(
      Object.keys(await db.getAllRegisteredGroups()).length,
    ).toBeGreaterThanOrEqual(1);
    expect(await db.getRegisteredGroup('nonexistent@g.us')).toBeUndefined();
  });

  it('handles upserts correctly', async () => {
    await db.setRegisteredGroup('verify@g.us', {
      name: 'Renamed Group',
      folder: 'verify',
      trigger: '@NewBot',
      added_at: '2025-02-01T00:00:00.000Z',
      requiresTrigger: false,
    });
    const upserted = await db.getRegisteredGroup('verify@g.us');
    expect(upserted!.name).toBe('Renamed Group');
    expect(upserted!.trigger).toBe('@NewBot');
    expect(upserted!.requiresTrigger).toBe(false);
    expect(Object.keys(await db.getAllRegisteredGroups())).toHaveLength(1);

    const chatsBefore = (await db.getAllChats()).length;
    await db.storeChatMetadata(
      'test-group@g.us',
      '2025-02-01T00:00:00.000Z',
      'Re-Updated',
      'whatsapp',
      true,
    );
    const chatsAfter = await db.getAllChats();
    expect(chatsAfter.find((c) => c.jid === 'test-group@g.us')?.name).toBe(
      'Re-Updated',
    );
    expect(chatsAfter).toHaveLength(chatsBefore);
  });

  it('preserves ContainerConfig through JSON roundtrip', async () => {
    await db.setRegisteredGroup('config-test@g.us', {
      name: 'Config Group',
      folder: 'config-test',
      trigger: '@Bot',
      added_at: '2025-01-01T00:00:00.000Z',
      requiresTrigger: true,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '~/projects',
            containerPath: '/workspace/extra/projects',
            readonly: true,
          },
        ],
        timeout: 600000,
      },
    });
    const cfg = (await db.getRegisteredGroup('config-test@g.us'))!;
    expect(cfg.containerConfig).toBeDefined();
    expect(cfg.containerConfig!.timeout).toBe(600000);
    expect(cfg.containerConfig!.additionalMounts![0].hostPath).toBe(
      '~/projects',
    );
  });

  it('handles special characters in names and content', async () => {
    await db.storeChatMetadata(
      'special@g.us',
      '2025-01-01T00:00:00.000Z',
      "O'Brien's 群组 🎉",
      'whatsapp',
      true,
    );
    const special = (await db.getAllChats()).find(
      (c) => c.jid === 'special@g.us',
    );
    expect(special?.name).toBe("O'Brien's 群组 🎉");

    await db.storeMessage({
      id: 'msg-special',
      chat_jid: 'special@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: "李明's phone",
      content: "It's a test with 中文 and 'quotes' and \"double quotes\"",
      timestamp: '2025-01-01T00:00:05.000Z',
      is_from_me: false,
    });
    const msgs = await db.getMessagesSince(
      'special@g.us',
      '2025-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("'quotes'");
    expect(msgs[0].sender_name).toBe("李明's phone");
  });

  it('stores channel and isGroup fields correctly', async () => {
    const group = (await db.getAllChats()).find(
      (c) => c.jid === 'test-group@g.us',
    );
    expect(group?.channel).toBe('whatsapp');
    expect(group?.is_group).toBe(1);

    const dm = (await db.getAllChats()).find(
      (c) => c.jid === 'test-dm@s.whatsapp.net',
    );
    expect(dm?.is_group).toBe(0);
  });

  it('persists data across close and re-init', async () => {
    await db.closeDatabase();
    await db.initDatabase();

    expect(
      Object.keys(await db.getAllRegisteredGroups()).length,
    ).toBeGreaterThanOrEqual(1);
    const reopened = await db.getRegisteredGroup('config-test@g.us');
    expect(reopened?.containerConfig?.timeout).toBe(600000);
  });

  // ------------------------------------------------------------------
  // Search service
  // ------------------------------------------------------------------

  it('initializes and operates search service lifecycle', async () => {
    if (dbType === 'sqlite') delete process.env.SEARCH_ENABLED;

    await search.initSearchService();
    const svc = search.getSearchService();
    expect(svc).toBeDefined();

    expect(await svc.searchMessages('anything')).toEqual([]);

    await svc.indexMessage({
      id: 'search-1',
      chat_jid: 'test-group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'search test',
      timestamp: '2025-01-01T00:00:10.000Z',
      is_from_me: false,
    });
    await svc.indexMessageBatch([
      {
        id: 'search-2',
        chat_jid: 'test-group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'Bob',
        content: 'batch message',
        timestamp: '2025-01-01T00:00:11.000Z',
        is_from_me: false,
      },
    ]);

    await search.closeSearchService();
  });

  it('processes IPC search requests via DI (no mocks)', async () => {
    const ipcDir = path.join(tempDir, 'ipc-search-test');

    const store = [
      {
        id: 'mem-1',
        content: 'Alice: contract deadline Friday',
        metadata: {
          chat_jid: 'g@g.us',
          sender: 'a@s',
          sender_name: 'Alice',
          timestamp: '2025-06-01T10:00:00Z',
        },
        score: 0.9,
      },
      {
        id: 'mem-2',
        content: 'Bob: lunch at noon',
        metadata: {
          chat_jid: 'g@g.us',
          sender: 'b@s',
          sender_name: 'Bob',
          timestamp: '2025-06-01T12:00:00Z',
        },
        score: 0.5,
      },
    ];
    const testSvc = {
      async init() {},
      async close() {},
      async indexMessage() {},
      async indexMessageBatch() {},
      async searchMessages(
        query: string,
        options?: { chatJid?: string; limit?: number },
      ) {
        return store
          .filter((e) => e.content.toLowerCase().includes(query.toLowerCase()))
          .slice(0, options?.limit ?? 10);
      },
    };

    await ipc.processSearchRequest(
      { id: 'req-1', query: 'contract', limit: 5 },
      ipcDir,
      testSvc,
    );
    const resp = JSON.parse(
      fs.readFileSync(path.join(ipcDir, 'responses', 'req-1.json'), 'utf-8'),
    );
    expect(resp.type).toBe('search_response');
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].id).toBe('mem-1');
    expect(resp.error).toBeUndefined();

    await ipc.processSearchRequest(
      { id: 'req-empty', query: 'xyz' },
      ipcDir,
      testSvc,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(ipcDir, 'responses', 'req-empty.json'),
          'utf-8',
        ),
      ).results,
    ).toHaveLength(0);

    const errSvc = {
      ...testSvc,
      async searchMessages() {
        throw new Error('test error');
      },
    };
    await ipc.processSearchRequest(
      { id: 'req-err', query: 'test' },
      ipcDir,
      errSvc,
    );
    const errResp = JSON.parse(
      fs.readFileSync(path.join(ipcDir, 'responses', 'req-err.json'), 'utf-8'),
    );
    expect(errResp.error).toBe('test error');
    expect(errResp.results).toEqual([]);

    expect(
      fs
        .readdirSync(path.join(ipcDir, 'responses'))
        .every((f) => !f.endsWith('.tmp')),
    ).toBe(true);
  });

  it('handles concurrent IPC search requests', async () => {
    const ipcDir = path.join(tempDir, 'ipc-concurrent');
    const svc = {
      async init() {},
      async close() {},
      async indexMessage() {},
      async indexMessageBatch() {},
      async searchMessages() {
        return [
          {
            id: 'r',
            content: 'ok',
            metadata: {
              chat_jid: '',
              sender: '',
              sender_name: '',
              timestamp: new Date().toISOString(),
            },
            score: 1,
          },
        ];
      },
    };

    await Promise.all([
      ipc.processSearchRequest({ id: 'c-1', query: 'a' }, ipcDir, svc),
      ipc.processSearchRequest({ id: 'c-2', query: 'b' }, ipcDir, svc),
      ipc.processSearchRequest({ id: 'c-3', query: 'c' }, ipcDir, svc),
    ]);

    expect(fs.readdirSync(path.join(ipcDir, 'responses')).sort()).toEqual([
      'c-1.json',
      'c-2.json',
      'c-3.json',
    ]);
  });

  it('simulates IPC directory scan flow', async () => {
    const scanDir = path.join(tempDir, 'ipc-scan');
    fs.mkdirSync(scanDir, { recursive: true });

    fs.writeFileSync(
      path.join(scanDir, 'req.json'),
      JSON.stringify({ type: 'search_request', id: 'scan-1', query: 'test' }),
    );

    const svc = {
      async init() {},
      async close() {},
      async indexMessage() {},
      async indexMessageBatch() {},
      async searchMessages() {
        return [];
      },
    };

    for (const file of fs
      .readdirSync(scanDir)
      .filter((f) => f.endsWith('.json'))) {
      const data = JSON.parse(
        fs.readFileSync(path.join(scanDir, file), 'utf-8'),
      );
      if (data.type === 'search_request') {
        await ipc.processSearchRequest(data, scanDir, svc);
      }
      fs.unlinkSync(path.join(scanDir, file));
    }

    expect(
      fs.readdirSync(scanDir).filter((f) => f.endsWith('.json')),
    ).toHaveLength(0);
    expect(fs.existsSync(path.join(scanDir, 'responses', 'scan-1.json'))).toBe(
      true,
    );
  });

  // ------------------------------------------------------------------
  // Context injection logic
  // ------------------------------------------------------------------

  it('builds context injection block and filters by score', () => {
    type SR = {
      id: string;
      content: string;
      metadata: { timestamp: string; sender_name: string };
      score: number;
    };

    const results: SR[] = [
      {
        id: 'c1',
        content: 'Alice: status',
        metadata: { timestamp: '2025-06-01T10:00:00Z', sender_name: 'Alice' },
        score: 0.9,
      },
      {
        id: 'c2',
        content: 'Bob: done',
        metadata: { timestamp: '2025-06-02T14:00:00Z', sender_name: 'Bob' },
        score: 0.7,
      },
      {
        id: 'c3',
        content: 'noise',
        metadata: { timestamp: '', sender_name: '' },
        score: 0.1,
      },
    ];

    const relevant = results.filter((r) => r.score > 0.3);
    expect(relevant).toHaveLength(2);

    const block = relevant
      .map(
        (r) =>
          `[${r.metadata.timestamp}] ${r.metadata.sender_name}: ${r.content}`,
      )
      .join('\n');
    const augmented = `<relevant_context>\n${block}\n</relevant_context>\n\nuser message`;

    expect(augmented).toContain('Alice: status');
    expect(augmented).toContain('Bob: done');
    expect(augmented).not.toContain('noise');
    expect(augmented.indexOf('<relevant_context>')).toBeLessThan(
      augmented.indexOf('user message'),
    );
  });

  it('skips context injection when all scores below threshold', () => {
    const relevant = [{ score: 0.1 }, { score: 0.2 }].filter(
      (r) => r.score > 0.3,
    );
    expect(relevant).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Service DI
  // ------------------------------------------------------------------

  it('supports _setServiceForTesting and _resetForTesting', async () => {
    await search.initSearchService();
    const orig = search.getSearchService();

    const custom = new noopMod.NoopSearchService();
    search._setServiceForTesting(custom);
    expect(search.getSearchService()).toBe(custom);

    search._setServiceForTesting(orig);
    expect(search.getSearchService()).toBe(orig);

    await search.closeSearchService();
  });
}

// ====================================================================
// Run the full suite against each DB type
// ====================================================================

describe('integration (sqlite)', () => {
  defineAdapterSuite('sqlite');
});

describe('integration (seekdb)', () => {
  defineAdapterSuite('seekdb');
});
