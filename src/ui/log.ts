/**
 * 应用日志（对应 Aegisub 的 agi::log：全局 sink，环形缓冲 250 条）。
 * 出口：① 底部状态栏单行消息（App 订阅后走 FrameMain::StatusTimeout 语义展示）；
 * ② View → Log window 弹窗（dialog_log）查看完整事件流；③ console 镜像。
 */

export type LogLevel = 'info' | 'warning' | 'error'

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  /** 来源子系统（fonts / drop / media / app …） */
  tag: string
  message: string
}

/** la/common/log.cpp：环形缓冲 250 条 */
const MAX_ENTRIES = 250

const entries: LogEntry[] = []
let nextId = 0
const listeners = new Set<(entry: LogEntry) => void>()

export function log(level: LogLevel, tag: string, message: string): void {
  const entry: LogEntry = { id: nextId++, time: Date.now(), level, tag, message }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  // 镜像到 console，保持 DevTools 可诊断性
  const text = `[${tag}] ${message}`
  if (level === 'error') console.error(text)
  else if (level === 'warning') console.warn(text)
  else console.info(text)
  for (const listener of listeners) listener(entry)
}

export const logInfo = (tag: string, message: string) => log('info', tag, message)
export const logWarning = (tag: string, message: string) => log('warning', tag, message)
export const logError = (tag: string, message: string) => log('error', tag, message)

export function getLogEntries(): readonly LogEntry[] {
  return entries
}

export function clearLogs(): void {
  entries.length = 0
}

export function subscribeLogs(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 全局兜底：未捕获异常 / Promise reject 记入日志（一次） */
let installed = false
export function installGlobalLogHandlers(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (event) => {
    log('error', 'app', event.message || 'Unknown error')
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
    log('error', 'app', `Unhandled rejection: ${reason}`)
  })
}
