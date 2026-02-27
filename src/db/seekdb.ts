/**
 * SeekdbAdapter — IDatabaseAdapter implementation using SeekdbClient.execute()
 * with MySQL/OceanBase SQL dialect.
 *
 * Requires the `seekdb` package.  Install with:
 *   npm install seekdb
 *
 * Supports both embedded mode (SEEKDB_PATH) and server mode (SEEKDB_HOST).
 */

import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import {
  mapRowToRegisteredGroup,
  serializeRegisteredGroup,
} from './helpers.js';
import type {
  ChatInfo,
  IDatabaseAdapter,
  RegisteredGroupRow,
  TaskUpdates,
} from './types.js';

interface SeekdbClient {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<Record<string, unknown>[] | null>;
  createDatabase(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface SeekdbConfig {
  path?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tenant?: string;
}

export class SeekdbAdapter implements IDatabaseAdapter {
  private client!: SeekdbClient;
  private config: SeekdbConfig;

  constructor(config: SeekdbConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const { SeekdbClient: SClient } = await import('seekdb');
    this.client = new SClient(this.config) as unknown as SeekdbClient;
    if (this.config.database) {
      await this.client.createDatabase(this.config.database);
    }
    await this.createSchema();
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async initTest(): Promise<void> {
    await this.init();
  }

  // -- helpers ------------------------------------------------------------

  private async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.client.execute(sql, params);
  }

  private async queryAll<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const rows = await this.client.execute(sql, params);
    return (rows ?? []) as T[];
  }

  private async queryOne<T>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    const rows = await this.client.execute(sql, params);
    return (rows?.[0] as T) ?? undefined;
  }

  // -- Schema & migrations ------------------------------------------------

  private async createSchema(): Promise<void> {
    // MySQL uses AUTO_INCREMENT (not AUTOINCREMENT) and doesn't support
    // multi-statement exec, so we run each DDL separately.
    await this.exec(`CREATE TABLE IF NOT EXISTS chats (
      jid VARCHAR(255) PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel VARCHAR(64),
      is_group INTEGER DEFAULT 0
    )`);

    await this.exec(`CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(255),
      chat_jid VARCHAR(255),
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    )`);

    await this.tryExec('CREATE INDEX idx_timestamp ON messages(timestamp)');

    await this.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id VARCHAR(255) PRIMARY KEY,
      group_folder VARCHAR(255) NOT NULL,
      chat_jid VARCHAR(255) NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type VARCHAR(64) NOT NULL,
      schedule_value VARCHAR(255) NOT NULL,
      context_mode VARCHAR(64) DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status VARCHAR(64) DEFAULT 'active',
      created_at TEXT NOT NULL
    )`);

    await this.tryExec(
      'CREATE INDEX idx_next_run ON scheduled_tasks(next_run)',
    );
    await this.tryExec('CREATE INDEX idx_status ON scheduled_tasks(status)');

    await this.exec(`CREATE TABLE IF NOT EXISTS task_run_logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      task_id VARCHAR(255) NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status VARCHAR(64) NOT NULL,
      result TEXT,
      error TEXT
    )`);

    await this.tryExec(
      'CREATE INDEX idx_task_run_logs ON task_run_logs(task_id, run_at)',
    );

    await this.exec(`CREATE TABLE IF NOT EXISTS router_state (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    await this.exec(`CREATE TABLE IF NOT EXISTS sessions (
      group_folder VARCHAR(255) PRIMARY KEY,
      session_id TEXT NOT NULL
    )`);

    await this.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
      jid VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      folder VARCHAR(255) NOT NULL UNIQUE,
      trigger_pattern VARCHAR(255) NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`);
  }

  /** Run a DDL statement, ignoring "already exists" errors. */
  private async tryExec(sql: string): Promise<void> {
    try {
      await this.exec(sql);
    } catch {
      /* index/column already exists */
    }
  }

  // -- Chats --------------------------------------------------------------

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    const ch = channel ?? null;
    const group = isGroup === undefined ? null : isGroup ? 1 : 0;

    if (name) {
      await this.exec(
        `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          last_message_time = GREATEST(last_message_time, VALUES(last_message_time)),
          channel = COALESCE(VALUES(channel), channel),
          is_group = COALESCE(VALUES(is_group), is_group)`,
        [chatJid, name, timestamp, ch, group],
      );
    } else {
      await this.exec(
        `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          last_message_time = GREATEST(last_message_time, VALUES(last_message_time)),
          channel = COALESCE(VALUES(channel), channel),
          is_group = COALESCE(VALUES(is_group), is_group)`,
        [chatJid, chatJid, timestamp, ch, group],
      );
    }
  }

  async updateChatName(chatJid: string, name: string): Promise<void> {
    await this.exec(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [chatJid, name, new Date().toISOString()],
    );
  }

  async getAllChats(): Promise<ChatInfo[]> {
    return this.queryAll<ChatInfo>(
      `SELECT jid, name, last_message_time, channel, is_group
      FROM chats ORDER BY last_message_time DESC`,
    );
  }

  async getLastGroupSync(): Promise<string | null> {
    const row = await this.queryOne<{ last_message_time: string }>(
      `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
    );
    return row?.last_message_time || null;
  }

  async setLastGroupSync(): Promise<void> {
    const now = new Date().toISOString();
    await this.exec(
      `REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
      [now],
    );
  }

  // -- Messages -----------------------------------------------------------

  async storeMessage(msg: NewMessage): Promise<void> {
    await this.exec(
      `REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
      ],
    );
  }

  async storeMessageDirect(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  }): Promise<void> {
    await this.exec(
      `REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
      ],
    );
  }

  async getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

    const placeholders = jids.map(() => '?').join(',');
    const sql = `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp
    `;

    const rows = await this.queryAll<NewMessage>(sql, [
      lastTimestamp,
      ...jids,
      `${botPrefix}:%`,
    ]);

    let newTimestamp = lastTimestamp;
    for (const row of rows) {
      if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    }

    return { messages: rows, newTimestamp };
  }

  async getMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
  ): Promise<NewMessage[]> {
    const sql = `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp
    `;
    return this.queryAll<NewMessage>(sql, [
      chatJid,
      sinceTimestamp,
      `${botPrefix}:%`,
    ]);
  }

  // -- Tasks --------------------------------------------------------------

  async createTask(
    task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
  ): Promise<void> {
    await this.exec(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.group_folder,
        task.chat_jid,
        task.prompt,
        task.schedule_type,
        task.schedule_value,
        task.context_mode || 'isolated',
        task.next_run,
        task.status,
        task.created_at,
      ],
    );
  }

  async getTaskById(id: string): Promise<ScheduledTask | undefined> {
    return this.queryOne<ScheduledTask>(
      'SELECT * FROM scheduled_tasks WHERE id = ?',
      [id],
    );
  }

  async getTasksForGroup(groupFolder: string): Promise<ScheduledTask[]> {
    return this.queryAll<ScheduledTask>(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
      [groupFolder],
    );
  }

  async getAllTasks(): Promise<ScheduledTask[]> {
    return this.queryAll<ScheduledTask>(
      'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
    );
  }

  async updateTask(id: string, updates: TaskUpdates): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.prompt !== undefined) {
      fields.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.schedule_type !== undefined) {
      fields.push('schedule_type = ?');
      values.push(updates.schedule_type);
    }
    if (updates.schedule_value !== undefined) {
      fields.push('schedule_value = ?');
      values.push(updates.schedule_value);
    }
    if (updates.next_run !== undefined) {
      fields.push('next_run = ?');
      values.push(updates.next_run);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (fields.length === 0) return;

    values.push(id);
    await this.exec(
      `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );
  }

  async deleteTask(id: string): Promise<void> {
    await this.exec('DELETE FROM task_run_logs WHERE task_id = ?', [id]);
    await this.exec('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
  }

  async getDueTasks(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    return this.queryAll<ScheduledTask>(
      `SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run`,
      [now],
    );
  }

  async updateTaskAfterRun(
    id: string,
    nextRun: string | null,
    lastResult: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.exec(
      `UPDATE scheduled_tasks
      SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
      WHERE id = ?`,
      [nextRun, now, lastResult, nextRun, id],
    );
  }

  async logTaskRun(log: TaskRunLog): Promise<void> {
    await this.exec(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        log.task_id,
        log.run_at,
        log.duration_ms,
        log.status,
        log.result,
        log.error,
      ],
    );
  }

  // -- Router state -------------------------------------------------------

  async getRouterState(key: string): Promise<string | undefined> {
    const row = await this.queryOne<{ value: string }>(
      'SELECT value FROM router_state WHERE `key` = ?',
      [key],
    );
    return row?.value;
  }

  async setRouterState(key: string, value: string): Promise<void> {
    await this.exec('REPLACE INTO router_state (`key`, value) VALUES (?, ?)', [
      key,
      value,
    ]);
  }

  // -- Sessions -----------------------------------------------------------

  async getSession(groupFolder: string): Promise<string | undefined> {
    const row = await this.queryOne<{ session_id: string }>(
      'SELECT session_id FROM sessions WHERE group_folder = ?',
      [groupFolder],
    );
    return row?.session_id;
  }

  async setSession(groupFolder: string, sessionId: string): Promise<void> {
    await this.exec(
      'REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
      [groupFolder, sessionId],
    );
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.queryAll<{
      group_folder: string;
      session_id: string;
    }>('SELECT group_folder, session_id FROM sessions');
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.group_folder] = row.session_id;
    }
    return result;
  }

  // -- Registered groups --------------------------------------------------

  async getRegisteredGroup(
    jid: string,
  ): Promise<(RegisteredGroup & { jid: string }) | undefined> {
    const row = await this.queryOne<RegisteredGroupRow>(
      'SELECT * FROM registered_groups WHERE jid = ?',
      [jid],
    );
    if (!row) return undefined;
    return mapRowToRegisteredGroup(row);
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    await this.exec(
      `REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      serializeRegisteredGroup(jid, group),
    );
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = await this.queryAll<RegisteredGroupRow>(
      'SELECT * FROM registered_groups',
    );
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      const mapped = mapRowToRegisteredGroup(row);
      if (mapped) {
        const { jid: _, ...rest } = mapped;
        result[row.jid] = rest;
      }
    }
    return result;
  }
}
