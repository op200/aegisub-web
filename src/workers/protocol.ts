import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from '../core/types'

export interface SearchSettings {
  find: string
  replaceWith?: string
  field?: 'text' | 'style' | 'actor' | 'effect'
  matchCase?: boolean
  useRegex?: boolean
  exactMatch?: boolean
  skipTags?: boolean
}

export interface SearchMatch {
  id: string
  start: number
  end: number
  field: string
}

export type CoreRequest =
  // 首条消息：主线程把文档绝对 base 传给 worker（worker 里 location 是脚本 URL，
  // 无法自行从相对 base 解析出 wasm 资产位置）
  | { id?: number; method: 'init'; baseUrl: string }
  | { id: number; method: 'state' }
  | { id: number; method: 'open'; bytes: Uint8Array; sourceName: string }
  | { id: number; method: 'restore'; document: SubtitleDocument }
  // amend = 显式修订上一次提交（源码 AssFile::Commit 的 commitId 回传）：只有编辑框文本/逐键
  // 字段、连续同字段的时间修改、同一次视觉工具拖拽才传 true；命令类提交省略（false）→ 各自成点
  | { id: number; method: 'apply'; commands: CoreCommand[]; label: string; amend?: boolean }
  | { id: number; method: 'undo' | 'redo' }
  | { id: number; method: 'export'; format?: SubtitleFormat }
  | { id: number; method: 'search'; settings: SearchSettings }
  | { id: number; method: 'replaceAll'; settings: SearchSettings }
  // Limits/Undo Levels 等运行时配置（无响应，fire-and-forget）
  | { id?: number; method: 'configure'; config: { undoLevels: number } }
  // 手动保存成功后通知核心：下一次提交不再与保存前合并（无响应，fire-and-forget）
  | { id?: number; method: 'markSaved' }
  // 选中/活动行实时同步核心：修订撤销栈顶条目（OnSelectionChanged 语义，无响应，fire-and-forget）
  | { id?: number; method: 'notifySelection'; ids: string[]; activeId: string | null }
  // 编辑框文本选区实时同步核心：修订撤销栈顶条目（OnTextSelectionChanged 语义，无响应）
  | {
      id?: number
      method: 'notifyTextSelection'
      pos: number
      selStart: number
      selEnd: number
    }

export interface CoreResponse {
  id: number
  result?: CoreState | Uint8Array | SearchMatch[] | number
  /**
   * 仅文本提交（视觉工具拖动逐帧改 \pos 等，或编辑框逐键输入）的增量结果：
   * 整份文档 structuredClone 在拖动时是主线程每帧最大单项开销（实测 5-13ms），
   * 此路径让主线程按 id 只替换受影响 cue 的 text，未变 cue 保持对象身份
   */
  delta?: CoreTextDelta
  error?: string
}

/** 见 CoreResponse.delta：apply 命令全部为 updateCue+仅 text 时的轻量结果 */
export interface CoreTextDelta {
  revision: number
  changes: { id: string; text: string }[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string
  redoLabel: string
}
