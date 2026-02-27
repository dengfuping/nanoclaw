#!/usr/bin/env tsx
/**
 * One-time ETL script: migrate data from SQLite to seekdb.
 *
 * Usage:
 *   SEEKDB_HOST=127.0.0.1 SEEKDB_DATABASE=nanoclaw tsx scripts/migrate-sqlite-to-seekdb.ts
 *
 * Reads from store/messages.db (SQLite) and writes to the seekdb instance
 * configured via SEEKDB_* environment variables.
 */

import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.resolve(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

interface Row {
  [key: string]: unknown;
}

async function main() {
  const { SeekdbClient } = await import('seekdb');

  const config = {
    path: process.env.SEEKDB_PATH || undefined,
    host: process.env.SEEKDB_HOST || undefined,
    port: process.env.SEEKDB_PORT
      ? parseInt(process.env.SEEKDB_PORT, 10)
      : undefined,
    user: process.env.SEEKDB_USER || undefined,
    password: process.env.SEEKDB_PASSWORD || undefined,
    database: process.env.SEEKDB_DATABASE || undefined,
    tenant: process.env.SEEKDB_TENANT || undefined,
  };

  console.log('Opening SQLite database:', DB_PATH);
  const sqlite = new Database(DB_PATH, { readonly: true });

  console.log('Connecting to seekdb...');
  const client = new SeekdbClient(config);
  if (config.database) {
    await client.createDatabase(config.database);
  }

  const tables = [
    {
      name: 'chats',
      columns: ['jid', 'name', 'last_message_time', 'channel', 'is_group'],
    },
    {
      name: 'messages',
      columns: [
        'id',
        'chat_jid',
        'sender',
        'sender_name',
        'content',
        'timestamp',
        'is_from_me',
        'is_bot_message',
      ],
    },
    {
      name: 'scheduled_tasks',
      columns: [
        'id',
        'group_folder',
        'chat_jid',
        'prompt',
        'schedule_type',
        'schedule_value',
        'context_mode',
        'next_run',
        'last_run',
        'last_result',
        'status',
        'created_at',
      ],
    },
    {
      name: 'task_run_logs',
      columns: [
        'task_id',
        'run_at',
        'duration_ms',
        'status',
        'result',
        'error',
      ],
    },
    {
      name: 'router_state',
      columns: ['key', 'value'],
    },
    {
      name: 'sessions',
      columns: ['group_folder', 'session_id'],
    },
    {
      name: 'registered_groups',
      columns: [
        'jid',
        'name',
        'folder',
        'trigger_pattern',
        'added_at',
        'container_config',
        'requires_trigger',
      ],
    },
  ];

  for (const table of tables) {
    const rows = sqlite
      .prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name}`)
      .all() as Row[];

    if (rows.length === 0) {
      console.log(`  ${table.name}: 0 rows (skip)`);
      continue;
    }

    console.log(`  ${table.name}: migrating ${rows.length} rows...`);

    const placeholders = table.columns.map(() => '?').join(', ');
    const colNames =
      table.name === 'router_state'
        ? table.columns.map((c) => (c === 'key' ? '`key`' : c)).join(', ')
        : table.columns.join(', ');
    const sql = `REPLACE INTO ${table.name} (${colNames}) VALUES (${placeholders})`;

    let migrated = 0;
    for (const row of rows) {
      const values = table.columns.map((col) => row[col] ?? null);
      await client.execute(sql, values);
      migrated++;
    }

    console.log(`  ${table.name}: ${migrated} rows migrated`);
  }

  sqlite.close();
  await client.close();
  console.log('Migration complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
