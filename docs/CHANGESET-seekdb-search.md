# Changeset: seekdb Semantic Search & Capability Enhancement

> This document covers all changes after the database adapter layer, including the semantic search subsystem, IPC search tool, code optimizations, and test coverage.
> For the database adapter layer itself, see [CHANGESET-db-adapter.md](./CHANGESET-db-adapter.md).

## Summary

Leveraging seekdb's Collection API (vector/hybrid retrieval), NanoClaw gains optional semantic search over chat messages. Container agents can use the `search_memory` tool to find relevant history by meaning, and an optional mode automatically injects related context before each agent execution.

## seekdb Capability Evaluation

### Advantages over SQLite

| Dimension | SQLite | seekdb |
|-----------|--------|--------|
| Structured queries | Full SQL | MySQL-compatible SQL |
| Vector search | Not supported | Native Collection API, cosine similarity |
| Hybrid search | Not supported | Full-text + vector with RRF fusion |
| Embedding models | N/A | 12 providers: local (all-MiniLM-L6-v2, Sentence Transformer, Ollama) and remote (OpenAI, Qwen, Cohere, Jina, VoyageAI, etc.) |
| Deployment modes | Single file | Embedded (local file) or Server (remote connection) |

### New Capabilities & Practical Value

| Capability | Scenario | Value |
|------------|----------|-------|
| **Message semantic search** | Agent calls `search_memory` to find "the approach we discussed before" | Recall relevant history across time and phrasing, not limited to recent N messages |
| **Hybrid retrieval fallback** | Automatic fallback when hybrid search fails | 3-tier degradation: hybrid → vector → empty |
| **Time-decay scoring** | Searching "what was discussed in the last meeting" weights recent messages higher | Exponential decay `e^(-0.1h)` prioritizes recency |
| **Automatic context injection** | Inject relevant history before agent starts | Zero-config memory enhancement, reduces need for users to provide context manually |
| **Async batch indexing** | Messages queued in memory, flushed every 5s or at 50 messages | Non-blocking to main message loop, low-latency ingestion |

### Design Trade-offs

- **seekdb-only**: SQLite users are unaffected; `NoopSearchService` has zero overhead
- **Local embedding first**: Default `@seekdb/default-embed` (all-MiniLM-L6-v2, 384-dim), no external API key needed; switchable to any of 12 seekdb embedding providers
- **IPC file protocol**: Search uses request/response files, reusing existing IPC mechanism without new network ports
- **Opt-in**: `SEARCH_ENABLED` for explicit toggle, `SEARCH_CONTEXT_ENABLED` for auto-injection

## Architecture

```
Message arrives
  │
  ├──→ Database (structured storage)
  │
  └──→ SearchService.enqueue() ──→ Batch queue ──→ SeekdbSearchService.indexMessageBatch()
                                                      │
                                                      ↓
                                              seekdb Collection
                                              (nanoclaw_messages)
                                                      │
Agent query ←── search_memory IPC ←── processSearchRequest() ←── 3-tier retrieval
                                                                  ├ 1. Hybrid (RRF)
                                                                  ├ 2. Vector (fallback)
                                                                  └ 3. Empty (last resort)
```

## New Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/search/types.ts` | 33 | `ISearchService` interface, `SearchResult`, `SearchOptions` |
| `src/search/index.ts` | 113 | Service factory, batch queue (5s / 50 msg flush), DI test helpers |
| `src/search/seekdb-search.ts` | 260 | Core: embedding, indexing, 3-tier retrieval, time decay |
| `src/search/noop-search.ts` | 20 | No-op implementation when search is disabled |
| `src/search/search.test.ts` | 592 | 34 unit tests (NoopSearch, SeekdbSearch mock, factory, batch queue, DI) |
| `src/integration.test.ts` | 416 | 36 integration tests (18 SQLite + 18 seekdb, including search lifecycle) |

## Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | `initSearchService()` at startup, `closeSearchService()` at shutdown; `enqueueForIndexing()` after message storage; optional context injection |
| `src/ipc.ts` | New `processSearchRequest()` with DI support; search directory polling; extracted `writeAtomicJson()` helper |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | New `search_memory` MCP tool (IPC request/poll response) |
| `.env.example` | New `SEARCH_ENABLED`, `EMBEDDING_PROVIDER`, `SEARCH_CONTEXT_ENABLED`, `SEARCH_CONTEXT_LIMIT` |
| `src/container-runtime.test.ts` | Mock `console.error` to suppress FATAL box in test output |
| `vitest.config.ts` | `LOG_LEVEL: 'silent'` to suppress pino output during tests |

## Documentation Updates

| File | Change |
|------|--------|
| `CLAUDE.md` | Key Files table: added `src/search/` entries |
| `README.md` | Architecture description and key files updated; cleaned "backend" terminology |
| `README_zh.md` | Synced Chinese version; cleaned "后端" terminology |
| `docs/REQUIREMENTS.md` | New "Semantic Search" architecture decision; "Database Backend" → "Database Layer" |
| `docs/CHANGESET-db-adapter.md` | Updated stale references (verify-adapter.ts → integration.test.ts); cleaned "backend" terminology |

## Code Optimizations

| Item | Details |
|------|---------|
| Eliminated double type assertions | Added index signature to `MessageMetadata`, removing `as unknown as Record<string, unknown>` |
| Variable naming | `any` → `internal` in tests; `backend` → `dbType` / "Database Layer" across code and docs |
| Vitest 4.x compatibility | Replaced deprecated `vi.fn<[T], R>()` generic syntax with `vi.fn()` |
| Error messages | seekdb-search embedding provider error now clearly states "not yet implemented" |
| Test output | Mocked `console.error` eliminates FATAL box; `LOG_LEVEL: 'silent'` eliminates pino noise |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_ENABLED` | Auto-enabled when `DB_TYPE=seekdb` | Explicit toggle for semantic search |
| `EMBEDDING_PROVIDER` | `default` | Embedding model: `default` (local all-MiniLM-L6-v2), or any `@seekdb/*` provider (install separately) |
| `SEARCH_CONTEXT_ENABLED` | `false` | Auto-inject relevant context before agent execution |
| `SEARCH_CONTEXT_LIMIT` | `3` | Max messages to inject as context |

## Test Coverage

All 422 tests pass (34 test files):

| Category | Count | Details |
|----------|-------|---------|
| Search unit tests | 34 | NoopSearch, SeekdbSearch (mocked), factory init, batch queue, DI helpers |
| Integration (SQLite) | 18 | DB adapter + search lifecycle, isolated temp directory |
| Integration (seekdb) | 18 | Same suite, seekdb embedded mode, separate temp directory |
| Other existing tests | 352 | DB mock, WhatsApp, IPC, routing, scheduler, container runtime, etc. |

```bash
npx vitest run                           # full suite
npx vitest run src/search/search.test.ts # search unit tests
npx vitest run src/integration.test.ts   # integration (SQLite + seekdb)
```

## Known Limitations

- Non-`default` embedding providers require separate installation (e.g. `npm install @seekdb/openai`)
- seekdb embedded mode may emit `OB_ABORT` on process exit (cosmetic, no data impact)
- Index queue is in-memory; abnormal process termination may lose unflushed messages (graceful shutdown is safe)
- `search_memory` IPC uses file polling (100ms interval), introducing inherent latency
