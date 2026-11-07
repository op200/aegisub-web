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

/** console 镜像里 [tag] 前缀的样式（DevTools 支持 %c；按级别上色便于扫读） */
const TAG_CONSOLE_STYLES: Record<LogLevel, string> = {
  info: 'color:#38bdf8;font-weight:600',
  warning: 'color:#f59e0b;font-weight:600',
  error: 'color:#ef4444;font-weight:600',
}

export function log(level: LogLevel, tag: string, message: string): void {
  const entry: LogEntry = { id: nextId++, time: Date.now(), level, tag, message }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  // 镜像到 console，保持 DevTools 可诊断性；message 作为独立参数传入，
  // 避免其中的 %c/%s 等格式符吃掉样式参数。
  const prefix = `%c[${tag}]`
  const style = TAG_CONSOLE_STYLES[level]
  if (level === 'error') console.error(prefix, style, message)
  else if (level === 'warning') console.warn(prefix, style, message)
  else console.info(prefix, style, message)
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
