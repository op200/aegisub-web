import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from '../core/types';

export interface SearchSettings {
  find: string;
  replaceWith?: string;
  field?: 'text' | 'style' | 'actor' | 'effect';
  matchCase?: boolean;
  useRegex?: boolean;
  exactMatch?: boolean;
  skipTags?: boolean;
}

export interface SearchMatch {
  id: string;
  start: number;
  end: number;
  field: string;
}

export type CoreRequest =
  | { id: number; method: 'state' }
  | { id: number; method: 'open'; bytes: Uint8Array; sourceName: string }
  | { id: number; method: 'restore'; document: SubtitleDocument }
  | { id: number; method: 'apply'; commands: CoreCommand[]; label: string }
  | { id: number; method: 'undo' | 'redo' }
  | { id: number; method: 'export'; format?: SubtitleFormat }
  | { id: number; method: 'search'; settings: SearchSettings }
  | { id: number; method: 'replaceAll'; settings: SearchSettings };

export interface CoreResponse {
  id: number;
  result?: CoreState | Uint8Array | SearchMatch[] | number;
  error?: string;
}
