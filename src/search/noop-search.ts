import type { NewMessage } from '../types.js';
import type { ISearchService, SearchResult, SearchOptions } from './types.js';

/**
 * No-op search service used when semantic search is disabled
 * (e.g., DB_TYPE=sqlite or SEARCH_ENABLED=false).
 */
export class NoopSearchService implements ISearchService {
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async indexMessage(_msg: NewMessage): Promise<void> {}
  async indexMessageBatch(_msgs: NewMessage[]): Promise<void> {}

  async searchMessages(
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResult[]> {
    return [];
  }
}
