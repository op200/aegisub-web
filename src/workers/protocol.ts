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
  | { id: number; method: 'apply'; commands: CoreCommand[]; label: string }
  | { id: number; method: 'undo' | 'redo' }
  | { id: number; method: 'export'; format?: SubtitleFormat }
  | { id: number; method: 'search'; settings: SearchSettings }
  | { id: number; method: 'replaceAll'; settings: SearchSettings }
  // Limits/Undo Levels 等运行时配置（无响应，fire-and-forget）
  | { id?: number; method: 'configure'; config: { undoLevels: number } }
  // 手动保存成功后通知核心：下一次提交不再与保存前合并（无响应，fire-and-forget）
  | { id?: number; method: 'markSaved' }

export interface CoreResponse {
  id: number
  result?: CoreState | Uint8Array | SearchMatch[] | number
  error?: string
}
