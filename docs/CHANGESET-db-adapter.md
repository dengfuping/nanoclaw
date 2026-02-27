# Changeset: Database Adapter Layer

## Summary

Introduce a pluggable database adapter layer supporting both SQLite (default) and seekdb backends. All database access now goes through `IDatabaseAdapter`, enabling seamless backend switching via `DB_TYPE` environment variable.

## Motivation

- Enable seekdb (OceanBase-based) as an alternative database backend for vector/hybrid search capabilities in the future
- Decouple application logic from SQLite-specific APIs
- Maintain full backward compatibility — no changes needed for existing SQLite users

## Architecture

```
Before:  src/db.ts (synchronous better-sqlite3 calls)
After:   src/db/index.ts → IDatabaseAdapter → SqliteAdapter | SeekdbAdapter
```

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/db/index.ts` | 218 | Adapter factory + public async API (drop-in replacement for old `src/db.ts`) |
| `src/db/types.ts` | 109 | `IDatabaseAdapter` interface, `ChatInfo`, `RegisteredGroupRow`, `TaskUpdates` |
| `src/db/sqlite.ts` | 580 | SQLite adapter (better-sqlite3, synchronous internally, async API) |
| `src/db/seekdb.ts` | 550 | seekdb adapter (MySQL-compatible SQL dialect, async) |
| `src/db/helpers.ts` | 56 | Shared `RegisteredGroup` mapping/serialization helpers |
| `scripts/verify-adapter.ts` | 340 | Integration verification (58 assertions, both backends) |
| `scripts/migrate-sqlite-to-seekdb.ts` | 151 | One-time ETL: SQLite → seekdb data migration |

### Deleted Files

| File | Lines | Reason |
|------|-------|--------|
| `src/db.ts` | 669 | Replaced by `src/db/` adapter layer |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Import path `db.js` → `db/index.js`, add `await` to all db calls |
| `src/ipc.ts` | Same import + async changes |
| `src/task-scheduler.ts` | Same import + async changes |
| `src/channels/whatsapp.ts` | Same import + async changes |
| `src/config.ts` | `STORE_DIR` respects `process.env.STORE_DIR` for test isolation |
| `setup/register.ts` | Replace direct SQLite with `initDatabase()` + `setRegisteredGroup()` |
| `setup/groups.ts` | Replace direct SQLite with adapter; inline sync script outputs JSON, parent writes via adapter |
| `setup/verify.ts` | Replace direct SQLite with `getAllRegisteredGroups()` |
| `setup/environment.ts` | Replace direct SQLite with `getAllRegisteredGroups()` |
| `.env.example` | Add `DB_TYPE` and seekdb configuration |
| `package.json` | Add `seekdb` dependency |

### Test Files

| File | Change |
|------|--------|
| `src/db.test.ts` | Import path update, mock async returns |
| `src/channels/whatsapp.test.ts` | Mock async db functions with `Promise.resolve()` |
| `src/ipc-auth.test.ts` | Same mock updates |
| `src/routing.test.ts` | Same mock updates |
| `src/task-scheduler.test.ts` | Same mock updates |

### Documentation

| File | Change |
|------|--------|
| `CLAUDE.md` | Key files table: `src/db.ts` → `src/db/` directory entries |
| `README.md` | Architecture diagram and key files list updated |
| `README_zh.md` | Same updates (Chinese) |
| `docs/REQUIREMENTS.md` | New "Database Backend" architecture decision; update SQLite references |

## Key Design Decisions

1. **Async-first API** — All `IDatabaseAdapter` methods return `Promise`. SQLite adapter wraps synchronous calls; seekdb is natively async. This is the only breaking API change.

2. **SQL dialect translation** — seekdb uses MySQL-compatible syntax. Key differences handled:
   - `AUTOINCREMENT` → `AUTO_INCREMENT`
   - `INSERT OR REPLACE` → `REPLACE INTO`
   - `ON CONFLICT DO UPDATE` → `ON DUPLICATE KEY UPDATE`
   - `INTEGER` booleans → same (both support 0/1)

3. **Zero config for SQLite users** — Default `DB_TYPE` is `sqlite`. No `.env` changes needed. Existing `store/messages.db` continues to work.

4. **Setup scripts use adapter** — All 4 setup scripts (`register`, `groups`, `verify`, `environment`) now go through the adapter layer instead of opening SQLite directly. The inline WhatsApp sync script in `groups.ts` was refactored to output JSON to stdout, with the parent process writing via the adapter.

5. **Environment variable naming** — `DB_TYPE` (not `DB_BACKEND`) to align with common conventions (`DB_TYPE`, `DB_HOST`, `DB_PORT`).

## Verification

Both backends pass 58 integration assertions covering:

| Category | Assertions | Tests |
|----------|-----------|-------|
| Lifecycle | 3 | init, close, re-init cycle |
| Chats | 8 | store, update, upsert, list, group sync |
| Messages | 7 | store, store-direct, query, filter bot messages |
| Tasks | 9 | CRUD, due tasks, run logging, cascade delete |
| Router state | 2 | get/set roundtrip |
| Sessions | 4 | get/set, list all |
| Registered groups | 6 | CRUD, missing key |
| Upsert behavior | 6 | conflict resolution for groups and chats |
| ContainerConfig JSON | 3 | nested object serialization roundtrip |
| Special characters | 4 | apostrophes, Unicode, emoji |
| channel/isGroup fields | 3 | field storage and retrieval |
| Data persistence | 3 | survive close + re-init cycle |

Run verification:
```bash
npx tsx scripts/verify-adapter.ts              # SQLite (default)
DB_TYPE=seekdb npx tsx scripts/verify-adapter.ts  # seekdb
```

## Known Limitations

- `store/messages.db` filename is a legacy name — the database stores 7 tables beyond messages. Renaming deferred to avoid migration complexity.
- seekdb embedded mode emits `OB_ABORT` on process exit (cosmetic, no data impact).
- `scripts/migrate-sqlite-to-seekdb.ts` is a one-time ETL tool, not automated migration.
