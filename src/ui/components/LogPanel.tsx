import { X } from 'lucide-react'
/**
 * Log window（src/dialog_log.cpp 的 Web 版：View → app/log 的独立弹窗）。
 * 显示 agi::log 环形缓冲的事件流（时间 / 级别 / 来源 / 消息），新消息自动滚动。
 * 注意：这不是底部状态栏——源码底部的单行消息走 FrameMain::StatusTimeout，
 * 由 App 直接显示，与本窗口无关。
 */
import { useEffect, useRef, useState } from 'react'

import { tPlain } from '../i18n'
import { clearLogs, getLogEntries, subscribeLogs, type LogEntry, type LogLevel } from '../log'

const LEVEL_LABEL: Record<LogLevel, string> = { info: 'INFO', warning: 'WARN', error: 'ERROR' }

function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function LogPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<readonly LogEntry[]>(() => getLogEntries())
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      subscribeLogs((entry) => {
        setEntries((current) => [...current, entry])
      }),
    [],
  )

  // 新消息时贴底滚动（仅当用户没有向上翻阅）
  useEffect(() => {
    const list = listRef.current
    if (!list || entries.length === 0) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [entries])

  return (
    <section className="log-window" role="log" aria-label={tPlain('Log window')}>
      <header className="log-window-header">
        <strong>{tPlain('Log window')}</strong>
        <span className="log-window-count">
          {entries.length} {tPlain('entries')}
        </span>
        <span className="dialog-spacer" />
        <button
          type="button"
          onClick={() => {
            clearLogs()
            setEntries(getLogEntries())
          }}
        >
          {tPlain('Clear')}
        </button>
        <button
          type="button"
          aria-label={tPlain('Close log')}
          title={tPlain('Close')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="log-window-list" ref={listRef}>
        {entries.length === 0 && <div className="log-window-empty">{tPlain('No events.')}</div>}
        {entries.map((entry) => (
          <div className={`log-window-row log-${entry.level}`} key={entry.id}>
            <span className="log-window-time">{formatTime(entry.time)}</span>
            <span className="log-window-level">{LEVEL_LABEL[entry.level]}</span>
            <span className="log-window-tag">{entry.tag}</span>
            <span className="log-window-message">{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
