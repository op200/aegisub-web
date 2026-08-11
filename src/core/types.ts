export type SubtitleFormat = 'ass' | 'srt';

export interface SubtitleStyle {
  id: string;
  name: string;
  fontName: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;
  outlineColor: string;
  backColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  scaleX: number;
  scaleY: number;
  spacing: number;
  angle: number;
  borderStyle: number;
  outline: number;
  shadow: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
  encoding: number;
  values: Record<string, string>;
}

export interface SubtitleCue {
  id: string;
  layer: number;
  startMs: number;
  endMs: number;
  style: string;
  actor: string;
  marginL: number;
  marginR: number;
  marginV: number;
  effect: string;
  text: string;
  comment: boolean;
  extra: Record<string, string>;
}

export interface RawSection {
  name: string;
  lines: string[];
}

export interface SubtitleDocument {
  format: SubtitleFormat;
  sourceName: string;
  revision: number;
  scriptInfo: Record<string, string>;
  styles: SubtitleStyle[];
  cues: SubtitleCue[];
  passthroughSections: RawSection[];
}

export type SortColumn = 'start' | 'end' | 'style' | 'actor' | 'effect' | 'layer';

export type CoreCommand =
  | { type: 'updateCue'; id: string; patch: Partial<Omit<SubtitleCue, 'id'>> }
  | { type: 'addCue'; afterId?: string; beforeId?: string; cue?: Partial<Omit<SubtitleCue, 'id'>> }
  | { type: 'deleteCues'; ids: string[] }
  | { type: 'duplicateCues'; ids: string[] }
  | { type: 'moveCues'; ids: string[]; direction: -1 | 1 }
  | { type: 'updateStyle'; id: string; patch: Partial<Omit<SubtitleStyle, 'id'>> }
  | { type: 'addStyle'; style?: Partial<Omit<SubtitleStyle, 'id'>> }
  | { type: 'deleteStyle'; id: string }
  | { type: 'reorderStyles'; ids: string[] }
  | { type: 'updateScriptInfo'; patch: Record<string, string> }
  | { type: 'sortCues' }
  | { type: 'sortCuesBy'; column: SortColumn };

export interface CoreState {
  document: SubtitleDocument;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  runtime: 'typescript' | 'wasm';
}

export interface StoredProject {
  version: 1;
  updatedAt: number;
  document: SubtitleDocument;
}
