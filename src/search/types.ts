import type { NewMessage } from '../types.js';

export interface SearchResult {
  id: string;
  content: string;
  metadata: {
    chat_jid: string;
    sender: string;
    sender_name: string;
    timestamp: string;
  };
  score: number;
  timeWeight?: number;
}

export interface SearchOptions {
  chatJid?: string;
  limit?: number;
  timeDecay?: boolean;
}

export interface ISearchService {
  init(): Promise<void>;
  close(): Promise<void>;

  indexMessage(msg: NewMessage): Promise<void>;
  indexMessageBatch(msgs: NewMessage[]): Promise<void>;

  searchMessages(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]>;
}
