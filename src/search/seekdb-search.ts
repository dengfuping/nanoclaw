/**
 * SeekdbSearchService — semantic search over chat messages using seekdb Collections.
 *
 * Uses a 3-tier retrieval fallback (inspired by eywa-chat):
 *   1. Hybrid search (full-text + vector, RRF fusion)
 *   2. Pure vector search (fallback)
 *   3. Empty result (last resort)
 *
 * Supports optional time-decay scoring (inspired by seekdb-agent-memory).
 */

import type { SeekdbConfig } from '../db/seekdb.js';
import type { NewMessage } from '../types.js';
import { logger } from '../logger.js';
import type { ISearchService, SearchResult, SearchOptions } from './types.js';

const COLLECTION_NAME = 'nanoclaw_messages';

interface MessageMetadata {
  chat_jid: string;
  sender: string;
  sender_name: string;
  timestamp: string;
  is_from_me: boolean;
  [key: string]: unknown;
}

/** Shared result shape returned by both query() and hybridSearch(). */
interface CollectionQueryResult<T = Record<string, unknown>> {
  ids: readonly (readonly string[])[];
  documents?: readonly (readonly (string | null)[])[];
  metadatas?: readonly (readonly (T | null)[])[];
  distances?: readonly (readonly (number | null)[])[];
}

interface SeekdbCollectionLike {
  add(options: {
    ids: string | string[];
    documents?: string | string[];
    metadatas?: Record<string, unknown> | Record<string, unknown>[];
  }): Promise<void>;
  query<T = Record<string, unknown>>(options: {
    queryTexts?: string | string[];
    nResults?: number;
    where?: Record<string, unknown>;
    include?: readonly string[];
  }): Promise<CollectionQueryResult<T>>;
  hybridSearch<T = Record<string, unknown>>(options: {
    query?: {
      whereDocument?: { $contains: string } | string;
      where?: Record<string, unknown>;
      nResults?: number;
    };
    knn?: {
      queryTexts?: string | string[];
      where?: Record<string, unknown>;
      nResults?: number;
    };
    rank?: { rrf?: { rankWindowSize?: number; rankConstant?: number } };
    nResults?: number;
    include?: readonly string[];
  }): Promise<CollectionQueryResult<T>>;
  count(): Promise<number>;
}

interface SeekdbClientLike {
  getOrCreateCollection(options: {
    name: string;
    embeddingFunction?: unknown;
  }): Promise<SeekdbCollectionLike>;
  createDatabase(name: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Embedding provider name. Maps to `@seekdb/{provider}` package
 * (except "default" which maps to `@seekdb/default-embed`).
 *
 * Available providers: default, openai, qwen, ollama, cohere, jina,
 * google-vertex, amazon-bedrock, sentence-transformer, siliconflow,
 * tencent-hunyuan, voyageai.
 */
export interface SeekdbSearchConfig extends SeekdbConfig {
  embeddingProvider?: string;
}

export class SeekdbSearchService implements ISearchService {
  private config: SeekdbSearchConfig;
  private client!: SeekdbClientLike;
  private collection!: SeekdbCollectionLike;

  constructor(config: SeekdbSearchConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const { SeekdbClient } = await import('seekdb');

    const embeddingFunction = await this.loadEmbeddingFunction();

    this.client = new SeekdbClient(this.config) as unknown as SeekdbClientLike;

    if (this.config.database) {
      await this.client.createDatabase(this.config.database);
    }

    this.collection = await this.client.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction,
    });

    const count = await this.collection.count();
    logger.info(
      { collection: COLLECTION_NAME, count },
      'Search service initialized',
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async indexMessage(msg: NewMessage): Promise<void> {
    try {
      await this.collection.add({
        ids: msg.id,
        documents: toDocument(msg),
        metadatas: toMetadata(msg),
      });
    } catch (err) {
      logger.warn({ err, msgId: msg.id }, 'Failed to index message');
    }
  }

  async indexMessageBatch(msgs: NewMessage[]): Promise<void> {
    if (msgs.length === 0) return;

    try {
      await this.collection.add({
        ids: msgs.map((m) => m.id),
        documents: msgs.map(toDocument),
        metadatas: msgs.map(toMetadata),
      });
    } catch (err) {
      logger.warn({ err, count: msgs.length }, 'Failed to index message batch');
    }
  }

  /**
   * 3-tier retrieval fallback:
   *   Tier 1: Hybrid search (full-text + vector, RRF fusion)
   *   Tier 2: Pure vector search
   *   Tier 3: Empty results
   */
  async searchMessages(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const where = options?.chatJid
      ? ({ chat_jid: options.chatJid } as Record<string, unknown>)
      : undefined;

    // Tier 1: Hybrid search
    try {
      const results = await this.collection.hybridSearch<MessageMetadata>({
        query: {
          whereDocument: query,
          where,
          nResults: limit * 2,
        },
        knn: {
          queryTexts: [query],
          where,
          nResults: limit * 2,
        },
        rank: { rrf: { rankWindowSize: 60, rankConstant: 60 } },
        nResults: limit,
        include: ['documents', 'metadatas', 'distances'],
      });

      if (results.ids[0]?.length > 0) {
        const formatted = this.formatResults(results);
        return options?.timeDecay ? applyTimeDecay(formatted) : formatted;
      }
    } catch (err) {
      logger.debug(
        { err },
        'Hybrid search failed, falling back to vector search',
      );
    }

    // Tier 2: Pure vector search
    try {
      const results = await this.collection.query<MessageMetadata>({
        queryTexts: [query],
        where,
        nResults: limit,
        include: ['documents', 'metadatas', 'distances'],
      });

      if (results.ids[0]?.length > 0) {
        const formatted = this.formatResults(results);
        return options?.timeDecay ? applyTimeDecay(formatted) : formatted;
      }
    } catch (err) {
      logger.debug({ err }, 'Vector search failed');
    }

    // Tier 3: empty
    return [];
  }

  private formatResults(results: {
    ids: readonly (readonly string[])[];
    documents?: readonly (readonly (string | null)[])[];
    metadatas?: readonly (readonly (MessageMetadata | null)[])[];
    distances?: readonly (readonly (number | null)[])[];
  }): SearchResult[] {
    const ids = results.ids[0] ?? [];
    const docs = results.documents?.[0] ?? [];
    const metas = results.metadatas?.[0] ?? [];
    const dists = results.distances?.[0] ?? [];

    return ids.map((id, i) => ({
      id,
      content: docs[i] ?? '',
      metadata: {
        chat_jid: metas[i]?.chat_jid ?? '',
        sender: metas[i]?.sender ?? '',
        sender_name: metas[i]?.sender_name ?? '',
        timestamp: metas[i]?.timestamp ?? '',
      },
      score: 1 - (dists[i] ?? 1),
    }));
  }

  private async loadEmbeddingFunction(): Promise<unknown> {
    const provider = this.config.embeddingProvider ?? 'default';
    const packageName =
      provider === 'default' ? '@seekdb/default-embed' : `@seekdb/${provider}`;

    try {
      const mod = await import(packageName);
      const Ctor = Object.values(mod).find(
        (v): v is new (...args: unknown[]) => unknown =>
          typeof v === 'function' &&
          /EmbeddingFunction$/.test((v as { name?: string }).name ?? ''),
      );
      if (!Ctor) {
        throw new Error(`No EmbeddingFunction class found in ${packageName}`);
      }
      return new Ctor();
    } catch (err) {
      throw new Error(
        `Failed to load embedding provider "${provider}" (${packageName}). ` +
          `Install it with: npm install ${packageName}. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function toDocument(msg: NewMessage): string {
  return `${msg.sender_name}: ${msg.content}`;
}

function toMetadata(msg: NewMessage): MessageMetadata {
  return {
    chat_jid: msg.chat_jid,
    sender: msg.sender,
    sender_name: msg.sender_name,
    timestamp: msg.timestamp,
    is_from_me: msg.is_from_me ?? false,
  };
}

function applyTimeDecay(results: SearchResult[]): SearchResult[] {
  const now = Date.now();
  return results
    .map((r) => {
      const hoursOld =
        (now - new Date(r.metadata.timestamp).getTime()) / 3_600_000;
      const timeWeight = Math.exp(-hoursOld * 0.1);
      return { ...r, timeWeight, score: r.score * timeWeight };
    })
    .sort((a, b) => b.score - a.score);
}
