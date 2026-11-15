/**
 * 字幕格式标识（与 Aegisub SubtitleFormat 注册表对应）。
 * mkv 仅作为打开容器（提取内嵌字幕轨），不作为文档保存格式。
 * ebu/transtation/encore 与源码一致：只能写出，不能读入。
 */
export type SubtitleFormat =
  | 'ass'
  | 'ssa'
  | 'srt'
  | 'txt'
  | 'ttxt'
  | 'microdvd'
  | 'ebu'
  | 'transtation'
  | 'encore'

export type SubtitleAttachmentGroup = 'font' | 'graphic'

/**
 * ASS 附件（ass_attachment.h）。
 * data 为原始文件字节的 base64（跨 worker/WASM JSON 传输）；name 保留 SSA 字体名改写。
 */
export interface SubtitleAttachment {
  name: string
  group: SubtitleAttachmentGroup
  data: string
}

/** [Aegisub Extradata] 条目（ass_file.h ExtradataEntry） */
export interface SubtitleExtradata {
  id: number
  key: string
  value: string
}

/** [Aegisub Project Garbage]（ass_file.h ProjectProperties） */
export interface ProjectProperties {
  automationScripts: string
  exportFilters: string
  exportEncoding: string
  styleStorage: string
  audioFile: string
  videoFile: string
  timecodesFile: string
  keyframesFile: string
  automationSettings: Record<string, string>
  videoZoom: number
  arValue: number
  scrollPosition: number
  activeRow: number
  arMode: number
  videoPosition: number
}

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
  attachments: SubtitleAttachment[]
  extradata: SubtitleExtradata[]
  properties: ProjectProperties
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
  /** ass_attachment：附件管理器添加/删除（name+group 唯一定位；data 为 base64） */
  | { type: 'addAttachment'; attachment: SubtitleAttachment }
  | { type: 'deleteAttachment'; name: string; group: SubtitleAttachmentGroup }
  /** [Aegisub Project Garbage] 增量写入 */
  | { type: 'updateProperties'; patch: Partial<ProjectProperties> }
  | { type: 'sortCues' }
  | { type: 'sortCuesBy'; column: SortColumn }
  /**
   * Automation 整表重放（auto4_lua_assfile.cpp ProcessingComplete 的 apply_lines）：
   * info/styles/cues 三段整替，每个撤销点一次 apply。info 缺省表示脚本未触碰信息段（保留现状）；
   * styles 空数组语义为"保留原样式"（源码会清空，但 web 下游依赖至少一个样式）
   */
  | {
      type: 'replaceDocument'
      info?: Record<string, string>
      styles?: Array<Partial<Omit<SubtitleStyle, 'id'>>>
      cues: Array<Partial<Omit<SubtitleCue, 'id'>>>
    }

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
