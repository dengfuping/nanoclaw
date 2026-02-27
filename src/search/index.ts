import { logger } from '../logger.js';
import type { NewMessage } from '../types.js';
import type { ISearchService } from './types.js';

export type { ISearchService, SearchResult, SearchOptions } from './types.js';

let service: ISearchService;

// Batch queue: accumulates messages, flushes every FLUSH_INTERVAL or FLUSH_SIZE
const FLUSH_INTERVAL = 5_000;
const FLUSH_SIZE = 50;
let queue: NewMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

export async function initSearchService(): Promise<void> {
  const dbType = process.env.DB_TYPE || 'sqlite';
  const searchEnabled = process.env.SEARCH_ENABLED
    ? process.env.SEARCH_ENABLED === 'true'
    : dbType === 'seekdb';

  if (!searchEnabled) {
    const { NoopSearchService } = await import('./noop-search.js');
    service = new NoopSearchService();
    logger.info('Search service disabled (noop)');
    return;
  }

  try {
    const { SeekdbSearchService } = await import('./seekdb-search.js');
    service = new SeekdbSearchService({
      path: process.env.SEEKDB_PATH || undefined,
      host: process.env.SEEKDB_HOST || undefined,
      port: process.env.SEEKDB_PORT
        ? parseInt(process.env.SEEKDB_PORT, 10)
        : undefined,
      user: process.env.SEEKDB_USER || undefined,
      password: process.env.SEEKDB_PASSWORD || undefined,
      database: process.env.SEEKDB_DATABASE || undefined,
      tenant: process.env.SEEKDB_TENANT || undefined,
      embeddingProvider: process.env.EMBEDDING_PROVIDER || undefined,
    });
    await service.init();
  } catch (err) {
    logger.warn(
      { err },
      'Failed to initialize search service, falling back to noop',
    );
    const { NoopSearchService } = await import('./noop-search.js');
    service = new NoopSearchService();
  }
}

export async function closeSearchService(): Promise<void> {
  await flushQueue();
  if (flushTimer) clearTimeout(flushTimer);
  await service?.close();
}

export function getSearchService(): ISearchService {
  return service;
}

/** @internal — testing only: replace the active search service */
export function _setServiceForTesting(svc: ISearchService): void {
  service = svc;
}

/** @internal — testing only: reset batch queue state */
export function _resetForTesting(): void {
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = false;
}

/**
 * Enqueue a message for async indexing. Fire-and-forget — errors are
 * silently logged. Batches are flushed every 5s or every 50 messages.
 */
export function enqueueForIndexing(msg: NewMessage): void {
  queue.push(msg);

  if (queue.length >= FLUSH_SIZE) {
    flushQueue().catch(() => {});
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushQueue().catch(() => {});
    }, FLUSH_INTERVAL);
  }
}

async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;

  const batch = queue;
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    await service.indexMessageBatch(batch);
    logger.debug({ count: batch.length }, 'Indexed message batch');
  } catch (err) {
    logger.warn({ err, count: batch.length }, 'Failed to flush index queue');
  } finally {
    flushing = false;
  }
}
