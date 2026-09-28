export type SubtitleFormat = 'ass' | 'srt'

export interface SubtitleStyle {
  id: string
  name: string
  fontName: string
  fontSize: number
  primaryColor: string
  secondaryColor: string
  outlineColor: string
  backColor: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  scaleX: number
  scaleY: number
  spacing: number
  angle: number
  borderStyle: number
  outline: number
  shadow: number
  alignment: number
  marginL: number
  marginR: number
  marginV: number
  encoding: number
  values: Record<string, string>
}

export interface SubtitleCue {
  id: string
  layer: number
  startMs: number
  endMs: number
  style: string
  actor: string
  marginL: number
  marginR: number
  marginV: number
  effect: string
  text: string
  comment: boolean
  extra: Record<string, string>
}

export interface RawSection {
  name: string
  lines: string[]
}

export interface SubtitleDocument {
  format: SubtitleFormat
  sourceName: string
  revision: number
  scriptInfo: Record<string, string>
  styles: SubtitleStyle[]
  cues: SubtitleCue[]
  passthroughSections: RawSection[]
}

export type SortColumn = 'start' | 'end' | 'style' | 'actor' | 'effect' | 'layer'

export type CoreCommand =
  | { type: 'updateCue'; id: string; patch: Partial<Omit<SubtitleCue, 'id'>> }
  | { type: 'addCue'; afterId?: string; beforeId?: string; cue?: Partial<Omit<SubtitleCue, 'id'>> }
  | { type: 'deleteCues'; ids: string[] }
  | { type: 'duplicateCues'; ids: string[] }
  | { type: 'moveCues'; ids: string[]; direction: -1 | 1 }
  | { type: 'updateStyle'; id: string; patch: Partial<Omit<SubtitleStyle, 'id'>> }
  /** StyleRenamer::Replace：脚本内该样式的引用改名（diag.Style 与 \r 标签） */
  | { type: 'renameStyleReferences'; from: string; to: string }
  | { type: 'addStyle'; style?: Partial<Omit<SubtitleStyle, 'id'>> }
  | { type: 'deleteStyle'; id: string }
  | { type: 'reorderStyles'; ids: string[] }
  | { type: 'updateScriptInfo'; patch: Record<string, string> }
  | { type: 'sortCues' }
  | { type: 'sortCuesBy'; column: SortColumn }
  /** Automation 整表重放（auto4_lua_assfile.cpp 的 modification 模型）：单步 undo */
  | { type: 'replaceCues'; cues: Array<Partial<Omit<SubtitleCue, 'id'>>> }

export interface CoreState {
  document: SubtitleDocument
  canUndo: boolean
  canRedo: boolean
  undoLabel: string
  redoLabel: string
  /**
   * 选中/活动行快照：随 undo/redo 恢复（subs_controller.cpp:Apply → SetSelectionAndActive）；
   * apply/state 响应中仅为核心侧镜像（UI 仍是选中状态的属主），不用于驱动 UI
   */
  selected: string[]
  activeId: string | null
  /**
   * 编辑框文本选区快照（subs_controller.cpp:UndoInfo pos/sel_start/sel_end）：
   * 随 undo/redo 恢复（Apply → SetInsertionPoint + SetSelection），UI 据此设置
   * textarea 选区/光标；pos 为插入点，start/end 为选区边界
   */
  textSelection: { pos: number; start: number; end: number }
  runtime: 'typescript' | 'wasm'
}

export interface StoredProject {
  version: 1
  updatedAt: number
  document: SubtitleDocument
}
