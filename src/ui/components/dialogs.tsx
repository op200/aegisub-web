import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  getOptionBool,
  getOptionDouble,
  getOptionInt,
  getOptionString,
  setOption,
} from '../../config/options'
import {
  commitDialogueBlock,
  isBadBlock,
  parseDialogueBlocks,
  stepDialogueBlock,
  type DialogueBlock,
} from '../../core/dialogueBlocks'
import {
  MATRIX_OPTIONS,
  RESAMPLE_AR_MANUAL,
  RESAMPLE_AR_STRETCH,
  getScriptInfo,
  getScriptResolution,
  matrixOptionFromHeader,
  parseYcbcrHeader,
  resampleCommands,
  ycbcrHeaderToEffective,
} from '../../core/resample'
import { formatEditorTime, formatVideoTime, parseEditorTime } from '../../core/time'
import { processTiming } from '../../core/timingProcessor'
import type { CoreCommand, SubtitleCue, SubtitleDocument, SubtitleStyle } from '../../core/types'
import { Framerate } from '../../core/vfr'
import type { DummyVideoOptions, MediaSource } from '../../platform/types'
import {
  clearShiftHistoryFile,
  loadShiftHistoryFile,
  saveShiftHistoryFile,
} from '../../storage/configStore'
import { listFontFaces } from '../../storage/fontStore'
import { aegisubHotkeyStrFirst } from '../aegisubHotkeys'
import { aegisubIconUrl } from '../aegisubIcons'
import { cssColorToHex, hexToCssColor } from '../color'
import { commandForShortcut, shortcutFromKeyboardEvent } from '../commands'
import {
  availableLocales,
  detectDefaultLocale,
  getLocale,
  localeLabel,
  setLocale,
  storeLanguage,
  t,
  tFmt,
  tPlain,
  tPlural,
} from '../i18n'

interface DialogProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}

// 弹窗 ESC 关闭栈：挂载顺序即层级顺序，仅栈顶弹窗响应 ESC（多级弹窗逐层关闭）。
// 冒泡阶段监听——热键捕获（capture 阶段 stopPropagation）可优先拦截。
type EscapeHandler = () => void
const escapeStack: EscapeHandler[] = []
let escapeListenerInstalled = false

function ensureEscapeListener() {
  if (escapeListenerInstalled) return
  escapeListenerInstalled = true
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const top = escapeStack[escapeStack.length - 1]
    if (!top) return
    event.preventDefault()
    event.stopPropagation()
    top()
  })
}

/** 注册到 ESC 关闭栈；active=false 时不响应（如 findMode 为 null 时） */
export function useEscapeClose(onClose: () => void, active = true) {
  const ref = useRef(onClose)
  useEffect(() => {
    ref.current = onClose
  })
  useEffect(() => {
    if (!active) return
    ensureEscapeListener()
    const handler = () => ref.current()
    escapeStack.push(handler)
    return () => {
      const index = escapeStack.indexOf(handler)
      if (index >= 0) escapeStack.splice(index, 1)
    }
  }, [active])
}

export function Dialog({ title, onClose, children, footer }: DialogProps) {
  useEscapeClose(onClose)
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="app-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button
            className="dialog-close"
            onClick={onClose}
            title={tPlain('Close')}
            aria-label={tPlain('Close')}
          >
            <X size={16} />
          </button>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shift Times
// ---------------------------------------------------------------------------

/** ?user/shift_history.json 条目（dialog_shift_times.cpp SaveHistory 的 JSON 键名） */
interface ShiftHistoryEntry {
  filename: string
  'is by time': boolean
  'is backward': boolean
  amount: string
  fields: number
  mode: number
  selection: { start: number; end: number }[]
}

/** get_history_string：文件, 幅度 方向, 字段, 行范围 */
function shiftHistoryLabel(entry: ShiftHistoryEntry) {
  const filename = entry.filename || tPlain('unsaved')
  // 帧模式幅度显示为 "N frames"（fmt_plural：n==1 取单数条目）
  let amount = entry.amount
  if (!entry['is by time']) {
    const count = Number.parseInt(entry.amount, 10) || 0
    const plural = tPlural('1 frame', '%s frames', count)
    amount = plural.includes('%s') ? plural.replace('%s', entry.amount) : plural
  }
  const direction = entry['is backward'] ? tPlain('backward') : tPlain('forward')
  const fields = entry.fields === 0 ? tPlain('s+e') : entry.fields === 1 ? tPlain('s') : tPlain('e')
  const selection = entry.selection ?? []
  let lines = ''
  if (entry.mode === 0) lines = tPlain('all')
  else if (entry.mode === 2) {
    if (selection.length) lines = tFmt('from %d onward', selection[0].start)
  } else {
    lines =
      tPlain('sel ') +
      selection
        .map((range) =>
          range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`,
        )
        .join(';')
  }
  return `${filename}, ${amount} ${direction}, ${fields}, ${lines}`
}

/** wxTextCtrl 的 ToLong 语义：整串可解析才取整，否则为 0（Process 不校验输入） */
function parseShiftFrames(text: string) {
  return /^-?\d+$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : 0
}

/** Process 的 Shift()：按时间直接相加；按帧经帧率映射（START/END 取整规则不同） */
function shiftCueTime(
  initialMs: number,
  shift: number,
  byTime: boolean,
  kind: 'start' | 'end',
  frameRate: Framerate,
) {
  if (byTime) return initialMs + shift
  return frameRate.timeAtFrame(shift + frameRate.frameAtTime(initialMs, kind), kind)
}

interface ShiftTimesDialogProps {
  cues: SubtitleCue[]
  selectedIds: string[]
  /** 字幕文件名（SaveHistory 记录；subs_controller.cpp:Filename().filename()） */
  fileName: string
  /** 项目帧率（project->Timecodes()）：未加载时帧模式禁用（OnTimecodesLoaded） */
  frameRate: Framerate
  onClose: () => void
  onApply: (commands: CoreCommand[], label: string) => void
}

export function ShiftTimesDialog({
  cues,
  selectedIds,
  fileName,
  frameRate,
  onClose,
  onApply,
}: ShiftTimesDialogProps) {
  const framesEnabled = frameRate.isLoaded()
  const hasSelection = selectedIds.length > 0
  // 初值来自 Options（dialog_shift_times.cpp 构造 OPT_GET；帧率未加载时保持在时间模式）
  const [byTime, setByTime] = useState(
    () => getOptionBool('Tool/Shift Times/ByTime') || !frameRate.isLoaded(),
  )
  const [amountText, setAmountText] = useState(() =>
    formatEditorTime(getOptionInt('Tool/Shift Times/Time')),
  )
  const [framesText, setFramesText] = useState(() =>
    String(getOptionInt('Tool/Shift Times/Frames')),
  )
  const [type, setType] = useState(() => getOptionInt('Tool/Shift Times/Type'))
  const [mode, setMode] = useState(() => getOptionInt('Tool/Shift Times/Affect'))
  const [backward, setBackward] = useState(() => getOptionBool('Tool/Shift Times/Direction'))
  const [history, setHistory] = useState<ShiftHistoryEntry[]>([])

  // 帧率未加载时强制时间模式（OnTimecodesLoaded：shift_by_time->SetValue(true)），
  // 无选中行时强制 All rows（OnSelectedSetChanged）：由状态派生，避免 effect 内 setState
  const activeByTime = framesEnabled ? byTime : true
  const activeMode = hasSelection ? mode : 0
  // LoadHistory：读取 ?user/shift_history.json
  useEffect(() => {
    void (async () => {
      const stored = await loadShiftHistoryFile()
      if (Array.isArray(stored)) setHistory(stored as ShiftHistoryEntry[])
    })()
  }, [])

  // 关闭时写回 Options（dialog_shift_times.cpp 析构 OPT_SET：无论 OK/Cancel 都保存）
  const latestRef = useRef({
    byTime: activeByTime,
    amountText,
    framesText,
    type,
    mode: activeMode,
    backward,
  })
  useEffect(() => {
    latestRef.current = {
      byTime: activeByTime,
      amountText,
      framesText,
      type,
      mode: activeMode,
      backward,
    }
  })
  useEffect(
    () => () => {
      const value = latestRef.current
      setOption('Tool/Shift Times/Time', parseEditorTime(value.amountText) ?? 0)
      setOption('Tool/Shift Times/Frames', parseShiftFrames(value.framesText))
      setOption('Tool/Shift Times/ByTime', value.byTime)
      setOption('Tool/Shift Times/Type', value.type)
      setOption('Tool/Shift Times/Affect', value.mode)
      setOption('Tool/Shift Times/Direction', value.backward)
    },
    [],
  )

  /** 双击历史条目：回填幅度/方向/字段/范围（OnHistoryClick；帧率未加载时不切帧模式） */
  const loadHistoryEntry = (entry: ShiftHistoryEntry) => {
    if (entry['is by time']) {
      setAmountText(formatEditorTime(parseEditorTime(entry.amount) ?? 0))
      setByTime(true)
    } else {
      setFramesText(entry.amount)
      if (framesEnabled) setByTime(false)
    }
    setBackward(entry['is backward'])
    setType(entry.fields)
    setMode(entry.mode)
  }

  const clearHistory = () => {
    setHistory([])
    void clearShiftHistoryFile()
  }

  const apply = () => {
    const start = type !== 2
    const end = type !== 1
    const magnitude = activeByTime
      ? (parseEditorTime(amountText) ?? 0)
      : parseShiftFrames(framesText)
    // Process：时间模式零位移不提交直接关闭；帧模式 0 帧也提交（源码 Commit 无条件建立撤销点）
    if (activeByTime && magnitude === 0) {
      onClose()
      return
    }
    const shift = backward ? -magnitude : magnitude
    const selSet = new Set(selectedIds)
    const commands: CoreCommand[] = []
    // 记录被平移的行块（历史条目用；0 基下标 +1 与源码 Row 语义一致）
    const blocks: { start: number; end: number }[] = []
    let blockStart = 0
    cues.forEach((cue, index) => {
      if (!selSet.has(cue.id)) {
        if (blockStart) {
          blocks.push({ start: blockStart, end: index })
          blockStart = 0
        }
        if (activeMode === 1) return
        if (activeMode === 2 && blocks.length === 0) return
      } else if (!blockStart) blockStart = index + 1

      const patch: Partial<Omit<SubtitleCue, 'id'>> = {}
      if (start) patch.startMs = shiftCueTime(cue.startMs, shift, activeByTime, 'start', frameRate)
      if (end) patch.endMs = shiftCueTime(cue.endMs, shift, activeByTime, 'end', frameRate)
      commands.push({ type: 'updateCue', id: cue.id, patch })
    })
    if (blockStart) blocks.push({ start: blockStart, end: cues.length })

    // SaveHistory：新条目插入最前，上限 50
    const entry: ShiftHistoryEntry = {
      filename: fileName,
      'is by time': activeByTime,
      'is backward': backward,
      amount: activeByTime ? formatEditorTime(magnitude) : framesText,
      fields: type,
      mode: activeMode,
      selection: blocks,
    }
    const nextHistory = [entry, ...history].slice(0, 50)
    setHistory(nextHistory)
    void saveShiftHistoryFile(nextHistory)

    onApply(commands, 'shifting')
    onClose()
  }

  return (
    <Dialog
      title={tPlain('Shift Times')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>{tPlain('OK')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="shift-times-body">
        <div className="shift-times-left">
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Shift by')}</legend>
            <div className="dialog-row">
              <label className="dialog-check" title={tPlain('Shift by time')}>
                <input
                  type="radio"
                  name="shift-by"
                  checked={activeByTime}
                  onChange={() => setByTime(true)}
                />{' '}
                {tPlain('Time: ')}
              </label>
              <input
                className="shift-times-input"
                value={amountText}
                disabled={!activeByTime}
                title={tPlain('Enter time in h:mm:ss.cs notation')}
                onChange={(event) => setAmountText(event.target.value)}
                onBlur={() => {
                  const ms = parseEditorTime(amountText)
                  if (ms !== null) setAmountText(formatEditorTime(ms))
                }}
                onKeyDown={(event) => {
                  // shift_time->Bind(wxEVT_TEXT_ENTER)：时间框回车即提交
                  if (event.key === 'Enter') apply()
                }}
              />
            </div>
            <div className="dialog-row">
              <label className="dialog-check" title={tPlain('Shift by frames')}>
                <input
                  type="radio"
                  name="shift-by"
                  checked={!activeByTime}
                  disabled={!framesEnabled}
                  onChange={() => setByTime(false)}
                />{' '}
                {tPlain('Frames: ')}
              </label>
              <input
                className="shift-times-input"
                value={framesText}
                disabled={activeByTime || !framesEnabled}
                title={tPlain('Enter number of frames to shift by')}
                onChange={(event) => setFramesText(event.target.value)}
              />
            </div>
            <div className="dialog-row">
              <label
                className="dialog-check"
                title={tPlain(
                  'Shifts subs forward, making them appear later. Use if they are appearing too soon.',
                )}
              >
                <input
                  type="radio"
                  name="shift-direction"
                  checked={!backward}
                  onChange={() => setBackward(false)}
                />{' '}
                {tPlain('Forward')}
              </label>
              <label
                className="dialog-check"
                title={tPlain(
                  'Shifts subs backward, making them appear earlier. Use if they are appearing too late.',
                )}
              >
                <input
                  type="radio"
                  name="shift-direction"
                  checked={backward}
                  onChange={() => setBackward(true)}
                />{' '}
                {tPlain('Backward')}
              </label>
            </div>
          </fieldset>
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Affect')}</legend>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-affect"
                checked={activeMode === 0}
                onChange={() => setMode(0)}
              />{' '}
              {tPlain('All rows')}
            </label>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-affect"
                checked={activeMode === 1}
                disabled={!hasSelection}
                onChange={() => setMode(1)}
              />{' '}
              {tPlain('Selected rows')}
            </label>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-affect"
                checked={activeMode === 2}
                disabled={!hasSelection}
                onChange={() => setMode(2)}
              />{' '}
              {tPlain('Selection onward')}
            </label>
          </fieldset>
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Times')}</legend>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-fields"
                checked={type === 0}
                onChange={() => setType(0)}
              />{' '}
              {tPlain('Start and End times')}
            </label>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-fields"
                checked={type === 1}
                onChange={() => setType(1)}
              />{' '}
              {tPlain('Start times only')}
            </label>
            <label className="dialog-check">
              <input
                type="radio"
                name="shift-fields"
                checked={type === 2}
                onChange={() => setType(2)}
              />{' '}
              {tPlain('End times only')}
            </label>
          </fieldset>
        </div>
        <fieldset className="dialog-fieldset shift-times-history">
          <legend>{tPlain('Load from history')}</legend>
          <ul>
            {history.map((entry, index) => (
              <li key={index} onDoubleClick={() => loadHistoryEntry(entry)}>
                {shiftHistoryLabel(entry)}
              </li>
            ))}
          </ul>
          <button onClick={clearHistory}>{tPlain('Clear')}</button>
        </fieldset>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Jump to
// ---------------------------------------------------------------------------
interface JumpToDialogProps {
  currentTimeMs: number
  durationMs: number
  onClose: () => void
  onJump: (timeMs: number) => void
}

export function JumpToDialog({ currentTimeMs, durationMs, onClose, onJump }: JumpToDialogProps) {
  const [value, setValue] = useState(Math.round(currentTimeMs))

  const jump = () => {
    const clamped = Math.max(0, Math.min(durationMs || value, value))
    onJump(clamped)
    onClose()
  }

  return (
    <Dialog
      title={tPlain('Jump to')}
      onClose={onClose}
      footer={
        <>
          <button onClick={jump}>{tPlain('Jump')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          {tPlain('Time (ms)')}
          <input
            type="number"
            value={value}
            onChange={(event) => setValue(Number(event.target.value))}
            autoFocus
          />
        </label>
        <label>
          {tPlain('Preview')}
          <input readOnly value={formatEditorTime(value)} />
        </label>
        <div className="dialog-row">
          <button type="button" onClick={() => setValue(0)}>
            {tPlain('Start')}
          </button>
          <button type="button" onClick={() => setValue(Math.max(0, durationMs))}>
            {tPlain('End')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Script Properties（对应 Aegisub dialog_properties.cpp）
// ---------------------------------------------------------------------------
interface ScriptPropertiesDialogProps {
  scriptInfo: Record<string, string>
  onClose: () => void
  onApply: (patch: Record<string, string>) => void
}

const PROPERTY_FIELDS = [
  ['Title', 'Title'],
  ['Original Script', 'Original Script'],
  ['Original Translation', 'Original Translation'],
  ['Original Editing', 'Original Editing'],
  ['Original Timing', 'Original Timing'],
  ['Synch Point', 'Synch Point'],
  ['Script Updated By', 'Script Updated By'],
  ['Update Details', 'Update Details'],
] as const

export function ScriptPropertiesDialog({
  scriptInfo,
  onClose,
  onApply,
}: ScriptPropertiesDialogProps) {
  const [values, setValues] = useState(() => ({ ...scriptInfo }))
  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }))
  const apply = () => {
    const patch: Record<string, string> = {}
    for (const [key, value] of Object.entries(values))
      if ((scriptInfo[key] ?? '') !== value) patch[key] = value
    for (const [key] of PROPERTY_FIELDS) if (!(key in values) && scriptInfo[key]) patch[key] = ''
    if (Object.keys(patch).length) onApply(patch)
    onClose()
  }

  return (
    <Dialog
      title={tPlain('Script Properties')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>{tPlain('OK')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields properties-fields">
        {PROPERTY_FIELDS.map(([key, label]) => (
          <label key={key}>
            {tPlain(label)}
            <input
              value={values[key] ?? ''}
              onChange={(event) => setValue(key, event.target.value)}
            />
          </label>
        ))}
        <label>
          {tPlain('PlayResX')}
          <input
            type="number"
            min={1}
            value={values.PlayResX ?? ''}
            onChange={(event) => setValue('PlayResX', event.target.value)}
          />
        </label>
        <label>
          {tPlain('PlayResY')}
          <input
            type="number"
            min={1}
            value={values.PlayResY ?? ''}
            onChange={(event) => setValue('PlayResY', event.target.value)}
          />
        </label>
        <label>
          {tPlain('LayoutResX')}
          <input
            type="number"
            min={0}
            value={values.LayoutResX ?? ''}
            onChange={(event) => setValue('LayoutResX', event.target.value)}
          />
        </label>
        <label>
          {tPlain('LayoutResY')}
          <input
            type="number"
            min={0}
            value={values.LayoutResY ?? ''}
            onChange={(event) => setValue('LayoutResY', event.target.value)}
          />
        </label>
        <label>
          {tPlain('Wrap Style')}
          <select
            value={values.WrapStyle ?? '0'}
            onChange={(event) => setValue('WrapStyle', event.target.value)}
          >
            <option value="0">{tPlain('0: Smart wrapping, top line wider')}</option>
            <option value="1">{tPlain('1: End-of-line word wrapping')}</option>
            <option value="2">{tPlain('2: No word wrapping')}</option>
            <option value="3">{tPlain('3: Smart wrapping, bottom line wider')}</option>
          </select>
        </label>
        <label>
          {tPlain('YCbCr Matrix')}
          <select
            value={values['YCbCr Matrix'] ?? 'None'}
            onChange={(event) => setValue('YCbCr Matrix', event.target.value)}
          >
            {['None', 'TV.601', 'PC.601', 'TV.709', 'PC.709', 'TV.2020', 'PC.2020'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="dialog-checkbox-row">
          {tPlain('Scaled Border and Shadow')}
          <input
            type="checkbox"
            checked={(values.ScaledBorderAndShadow ?? 'yes').toLowerCase() === 'yes'}
            onChange={(event) =>
              setValue('ScaledBorderAndShadow', event.target.checked ? 'yes' : 'no')
            }
          />
        </label>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Styling Assistant（dialog_styling_assistant.cpp DialogStyling）
// ---------------------------------------------------------------------------

/** 「Keys」栏 6 行（源码 add_hotkey 顺序：命令 id + 描述 msgid），末行两字面串 */
const STYLING_ASSISTANT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['tool/styling_assistant/commit', 'Accept changes'],
  ['tool/styling_assistant/preview', 'Preview changes'],
  ['grid/line/prev', 'Previous line'],
  ['grid/line/next', 'Next line'],
  ['video/play/line', 'Play video'],
  ['audio/play/selection', 'Play audio'],
]

/** 源码 edit_line_copy/cut/paste 内部检查焦点：聚焦文本控件时走控件自身剪贴板操作 */
const STYLING_NATIVE_TEXT_COMMANDS = new Set(['edit/line/cut', 'edit/line/copy', 'edit/line/paste'])

interface StylingAssistantDialogProps {
  cue: SubtitleCue
  /** c->ass->GetStyles()：文件顺序的全部样式名 */
  styles: SubtitleStyle[]
  hasAudio: boolean
  hasVideo: boolean
  onClose: () => void
  /** Commit：label "styling assistant"，COMMIT_DIAG_META（值按输入原样赋值） */
  onApply: (id: string, style: string) => void
  /** OnActiveLineChanged / OnActivate 的 JumpToTime(active_line->Start)（勾选 Seek 时） */
  onSeekVideo: (timeMs: number) => void
  /** hotkey::check 命中的其他上下文命令（导航/播放/撤销等，命中即消费） */
  onCommand: (id: string) => void
}

export function StylingAssistantDialog({
  cue,
  styles,
  hasAudio,
  hasVideo,
  onClose,
  onApply,
  onSeekVideo,
  onCommand,
}: StylingAssistantDialogProps) {
  const [input, setInput] = useState({ value: cue.style, invalid: false })
  const [listSelected, setListSelected] = useState(cue.style)
  const [autoSeek, setAutoSeek] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastIdRef = useRef(cue.id)
  /** 补全后待应用的选区（wx SetSelection(prefix.size(), style.size())） */
  const pendingSelectionRef = useRef<[number, number] | null>(null)

  // 每次编辑都写入新对象引用（React 同值时会跳过重渲染，导致选区不生效）
  const applyEdit = (value: string, selection: [number, number] | null, invalid: boolean) => {
    pendingSelectionRef.current = selection
    setInput({ value, invalid })
  }

  // 源码 OnStyleBoxModified：前缀匹配列表顺序首个样式并补全（选中补全部分），无匹配标红
  const applyAutocomplete = (value: string, cursor: number) => {
    const prefix = value.slice(0, cursor).toLowerCase()
    if (prefix === '') {
      applyEdit(value, null, false)
      return
    }
    const match = styles.find((item) => item.name.toLowerCase().startsWith(prefix))
    if (match) applyEdit(match.name, [prefix.length, match.name.length], false)
    else applyEdit(value, null, true)
  }

  /** 源码 OnActiveLineChanged：填充当前行样式名（全选）、列表选中、按需 Seek、回焦输入框 */
  const loadLine = (line: SubtitleCue, seek: boolean) => {
    applyEdit(line.style, [0, line.style.length], false)
    // SetStringSelection：样式不在列表中时保持原选中（wx 行为）
    if (styles.some((item) => item.name === line.style)) setListSelected(line.style)
    if (seek && hasVideo) onSeekVideo(line.startMs)
    inputRef.current?.focus()
  }

  /** 源码 Commit：GetStyle 大小写不敏感匹配，存在才提交；next 时执行 grid/line/next */
  const commitValue = (value: string, next: boolean) => {
    if (!styles.some((item) => item.name.toLowerCase() === value.toLowerCase())) return
    onApply(cue.id, value)
    if (next) onCommand('grid/line/next')
  }

  // 选区必须在 DOM 更新后设置（ChangeValue/SetSelection 的等价时序）
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending) return
    pendingSelectionRef.current = null
    inputRef.current?.setSelectionRange(pending[0], pending[1])
  })

  // 构造（OnActiveLineChanged(GetActiveLine())）+ 激活（OnActivate）净效果：勾选时 Seek 一次
  useEffect(() => {
    loadLine(cue, autoSeek)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅构造期执行一次
  }, [])

  // 活动行变化（selection controller ActiveLine 监听）
  useEffect(() => {
    if (lastIdRef.current === cue.id) return
    lastIdRef.current = cue.id
    loadLine(cue, autoSeek)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖为活动行 id
  }, [cue.id])

  /** 源码 OnListClicked / OnListDoubleClicked：ChangeValue + Commit + SetFocus */
  const pickFromList = (name: string, next: boolean) => {
    setListSelected(name)
    applyEdit(name, null, false)
    commitValue(name, next)
    inputRef.current?.focus()
  }

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target
    applyAutocomplete(target.value, target.selectionStart ?? target.value.length)
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 源码 OnKeyDown：无修饰键的 Backspace 先把选区起点前移一位，
    // 使 backspace 能删掉一个字符 + 补全部分（打破补全循环）
    if (event.key !== 'Backspace' || event.ctrlKey || event.altKey || event.metaKey) return
    const target = event.currentTarget
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? 0
    if (start <= 0) return
    event.preventDefault()
    applyAutocomplete(target.value.slice(0, start - 1) + target.value.slice(end), start - 1)
  }

  // 对话框按键：wxEVT_CHAR_HOOK → hotkey::check("Styling Assistant")
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    // 原生控件自行消费导航/激活键（wxCheckBox/wxButton 同理）
    if (target.matches('input[type="checkbox"], button, select')) return
    const command = commandForShortcut(
      shortcutFromKeyboardEvent(event.nativeEvent),
      'Styling Assistant',
    )
    if (!command || STYLING_NATIVE_TEXT_COMMANDS.has(command)) return
    event.preventDefault()
    event.stopPropagation()
    switch (command) {
      case 'tool/styling_assistant/commit':
        commitValue(input.value, true)
        return
      case 'tool/styling_assistant/preview':
        commitValue(input.value, false)
        return
      default:
        onCommand(command)
    }
  }

  return (
    <Dialog
      title={tPlain('Styling Assistant')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
          <button
            onClick={() =>
              window.open(
                'https://aegisub.org/docs/latest/styling_assistant/',
                '_blank',
                'noopener',
              )
            }
          >
            {tPlain('Help')}
          </button>
        </>
      }
    >
      <div
        className="styling-assistant-body"
        data-shortcut-context="Styling Assistant"
        onKeyDown={handleKeyDown}
      >
        <fieldset className="dialog-fieldset styling-assistant-current-line">
          <legend>{tPlain('Current line')}</legend>
          <textarea className="styling-current-text" readOnly value={cue.text} />
        </fieldset>
        <div className="styling-assistant-row">
          <fieldset className="dialog-fieldset styling-assistant-styles">
            <legend>{tPlain('Styles available')}</legend>
            {/* web 偏差：不还原键盘方向键导航——wx EVT_LISTBOX 会在每个方向键后
                ChangeValue + Commit(false) + SetFocus（逐格应用样式并把焦点弹回输入框） */}
            <div
              className="styling-styles-list"
              role="listbox"
              aria-label={tPlain('Styles available')}
            >
              {styles.map((item) => (
                <div
                  key={item.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={item.name === listSelected}
                  className={
                    item.name === listSelected
                      ? 'styling-style-option selected'
                      : 'styling-style-option'
                  }
                  // wx EVT_LISTBOX 仅在选中项变化时触发
                  onClick={() => {
                    if (item.name === listSelected) return
                    pickFromList(item.name, false)
                  }}
                  onDoubleClick={() => pickFromList(item.name, true)}
                >
                  {item.name}
                </div>
              ))}
            </div>
          </fieldset>
          <div className="styling-assistant-right">
            <fieldset className="dialog-fieldset">
              <legend>{tPlain('Set style')}</legend>
              <input
                ref={inputRef}
                className={input.invalid ? 'styling-style-input invalid' : 'styling-style-input'}
                value={input.value}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
              />
            </fieldset>
            <fieldset className="dialog-fieldset">
              <legend>{tPlain('Keys')}</legend>
              <div className="styling-keys-grid">
                {STYLING_ASSISTANT_KEYS.flatMap(([command, label]) => [
                  <span key={`${command}-label`}>{tPlain(label)}</span>,
                  <span key={`${command}-key`} className="styling-key">
                    {aegisubHotkeyStrFirst('Styling Assistant', command)}
                  </span>,
                ])}
                <span key="click-on-list">{tPlain('Click on list')}</span>
                <span key="select-style">{tPlain('Select style')}</span>
              </div>
              <label className="styling-seek-check">
                <input
                  type="checkbox"
                  checked={autoSeek}
                  onChange={(event) => setAutoSeek(event.target.checked)}
                />
                {tPlain('Seek video to line start time')}
              </label>
            </fieldset>
            <fieldset className="dialog-fieldset styling-assistant-actions">
              <legend>{tPlain('Actions')}</legend>
              <button
                disabled={!hasAudio}
                onClick={() => {
                  onCommand('audio/play/selection')
                  inputRef.current?.focus()
                }}
              >
                {tPlain('Play Audio')}
              </button>
              <button
                disabled={!hasVideo}
                onClick={() => {
                  onCommand('video/play/line')
                  inputRef.current?.focus()
                }}
              >
                {tPlain('Play Video')}
              </button>
            </fieldset>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

export function ToolInfoDialog({
  title,
  message,
  onClose,
}: {
  title: string
  message: string
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={<button onClick={onClose}>{tPlain('Close')}</button>}
    >
      <p className="tool-info-message">{message}</p>
    </Dialog>
  )
}

export function AttachmentDialog({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([])
  return (
    <Dialog
      title={tPlain('Attachments')}
      onClose={onClose}
      footer={<button onClick={onClose}>{tPlain('Close')}</button>}
    >
      <div className="attachment-dialog-body">
        <input
          type="file"
          multiple
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
        />
        <table>
          <thead>
            <tr>
              <th>{tPlain('Name')}</th>
              <th>{tPlain('Size')}</th>
              <th>{tPlain('Group')}</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={`${file.name}-${file.size}`}>
                <td>{file.name}</td>
                <td>{Math.ceil(file.size / 1024)} KB</td>
                <td>
                  {/\.(ttf|ttc|otf|pfb)$/i.test(file.name) ? tPlain('Fonts') : tPlain('Graphics')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {tPlain(
            'Browser attachment storage is limited to this dialog session. ASS export attachment embedding will be added with the binary document store.',
          )}
        </p>
      </div>
    </Dialog>
  )
}

type LocalFontPermission = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'

interface LocalFontApi {
  queryLocalFonts?: (options?: {
    postscriptNames?: string[]
  }) => Promise<
    Array<{ family: string; fullName?: string; postscriptName?: string; style: string }>
  >
}

/** 探测 Local Font Access（libass 只能消费字体文件字节，系统字体必须经 queryLocalFonts 授权后读取） */
export async function probeLocalFonts(): Promise<{
  supported: boolean
  permission: LocalFontPermission
}> {
  const api = window as Window & LocalFontApi
  if (!api.queryLocalFonts) return { supported: false, permission: 'unsupported' }
  try {
    const { state } = await navigator.permissions.query({ name: 'local-fonts' as PermissionName })
    return { supported: true, permission: state as LocalFontPermission }
  } catch {
    // permissions.query 不认识 local-fonts（部分浏览器）——但 API 本身可能仍可用
    return { supported: true, permission: 'unknown' }
  }
}

export function FontCollectorDialog({
  styles,
  text,
  onLocalFontsAuthorized,
  onClose,
}: {
  styles: SubtitleStyle[]
  text: string
  /** 授权成功后回调：libass 需重建实例才会用新权限重新匹配字体 */
  onLocalFontsAuthorized?: () => void
  onClose: () => void
}) {
  const [supported, setSupported] = useState(false)
  const [permission, setPermission] = useState<LocalFontPermission>('unknown')
  const [localFamilies, setLocalFamilies] = useState<Set<string> | null>(null)
  // 拖入/导入进 IndexedDB 的字体缓存同样可供 libass 使用——Firefox 无 Local Font
  // Access 时的主通道，可用性检查必须包含（名字集含 name 表全部记录）
  const [cachedNames, setCachedNames] = useState<Set<string> | null>(null)
  const [error, setError] = useState('')

  const loadLocalFonts = async (): Promise<boolean> => {
    const api = window as Window & LocalFontApi
    if (!api.queryLocalFonts) return false
    try {
      // 首次调用必须发生在用户手势内（触发原生授权框）；已授权后可随时全量枚举。
      // 字幕引用的字体名可能落在 fullName/postscriptName 上（如 方正兰亭中黑_GBK
      // 的 family 是 FZLanTingHei-DB-GBK），三个名字都收进可用性集合
      const list = await api.queryLocalFonts()
      setLocalFamilies(
        new Set(
          list.flatMap((font) => [
            font.family.toLowerCase(),
            (font.fullName ?? '').toLowerCase(),
            (font.postscriptName ?? '').toLowerCase(),
          ]),
        ),
      )
      setPermission('granted')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }

  useEffect(() => {
    void probeLocalFonts().then(({ supported: value, permission: state }) => {
      setSupported(value)
      setPermission(state)
      // 已授权：打开对话框即枚举本机字体，直接给出每个需求字体的可用性
      if (state === 'granted') void loadLocalFonts()
    })
    // 仅挂载时探测一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void listFontFaces().then((records) =>
      setCachedNames(
        new Set(
          records.flatMap((record) =>
            [...record.families, ...record.fullNames, ...record.postscriptNames].map((name) =>
              name.toLowerCase(),
            ),
          ),
        ),
      ),
    )
  }, [])

  const fonts = useMemo(() => {
    const names = styles.map((style) => style.fontName.replace(/^@/, ''))
    // \fn 前缀 @ 是竖排标记（libass 自行剥离），不参与字体名匹配
    for (const match of text.matchAll(/\\fn([^\\}]+)/g)) names.push(match[1].replace(/^@/, ''))
    return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b))
  }, [styles, text])

  const grantLocalFonts = async () => {
    setError('')
    const ok = await loadLocalFonts()
    if (ok) onLocalFontsAuthorized?.()
  }

  const status = (name: string): string => {
    const lower = name.toLowerCase()
    if (cachedNames?.has(lower)) return 'installed'
    if (!localFamilies) return permission === 'granted' ? 'unknown' : 'not checked'
    return localFamilies.has(lower) ? 'installed' : 'missing'
  }

  return (
    <Dialog
      title={tPlain('Fonts Collector')}
      onClose={onClose}
      footer={<button onClick={onClose}>{tPlain('Close')}</button>}
    >
      <div className="tool-list-dialog">
        <p>{tPlain('Fonts referenced by the current subtitle:')}</p>
        <ul>
          {fonts.map((font) => (
            <li key={font}>
              {font}
              <span className="font-status" data-status={status(font)}>
                {' '}
                — {status(font)}
              </span>
            </li>
          ))}
        </ul>
        <p>
          {tPlain(
            'libass renders subtitles from font file data. System fonts are exposed via the Local Font Access API (Chromium only); font files dropped onto the window are cached and available in any browser.',
          )}
          {supported
            ? ''
            : tPlain(
                ' This browser does not support it — drop font files below or use [Fonts] embedded in the subtitle.',
              )}
        </p>
        {supported && permission !== 'granted' && (
          <p>
            <button onClick={() => void grantLocalFonts()}>
              {tPlain('Grant local font access')}
            </button>
          </p>
        )}
        {supported && permission === 'granted' && (
          <p>
            {tPlain('Local font access granted')}
            {localFamilies ? ` — ${localFamilies.size} families visible to libass` : ''}
            {tPlain('. Fonts installed on this system (e.g. CJK fonts) are matched by name.')}
          </p>
        )}
        {error && (
          <p role="alert">
            <strong>{error}</strong>
          </p>
        )}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Translation Assistant（dialog_translation.cpp DialogTranslation）
// ---------------------------------------------------------------------------

/** 「Keys」栏 8 行（源码 add_hotkey 顺序：命令 id + 描述 msgid） */
const TRANSLATION_ASSISTANT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['tool/translation_assistant/commit', 'Accept changes'],
  ['tool/translation_assistant/preview', 'Preview changes'],
  ['tool/translation_assistant/prev', 'Previous line'],
  ['tool/translation_assistant/next', 'Next line'],
  ['tool/translation_assistant/insert_original', 'Insert original'],
  ['video/play/line', 'Play video'],
  ['audio/play/selection', 'Play audio'],
  ['edit/line/delete', 'Delete line'],
]

/** 源码 edit_line_copy/cut/paste 内部检查焦点：聚焦文本控件时走控件自身剪贴板操作 */
const TRANSLATION_NATIVE_TEXT_COMMANDS = new Set([
  'edit/line/cut',
  'edit/line/copy',
  'edit/line/paste',
])

interface TranslationDialogProps {
  cue: SubtitleCue
  /** 全部对白行（源码 c->ass->Events：行数显示与跨行导航） */
  cues: SubtitleCue[]
  hasAudio: boolean
  hasVideo: boolean
  onClose: () => void
  /** selectionController->NextLine()/PrevLine() 语义（SetSelectionAndActive） */
  onSelectCue: (id: string) => void
  /** 提交译文（Commit：label "translation assistant"，COMMIT_DIAG_TEXT） */
  onApply: (id: string, text: string) => void
  /** UpdateDisplay 的 JumpToTime(active_line->Start)（Enable preview 勾选时） */
  onSeekVideo: (timeMs: number) => void
  /** hotkey::check 命中的其他上下文命令（删除行/撤销/播放等，命中即消费） */
  onCommand: (id: string) => void
  /** wxMessageBox 等价（状态栏） */
  onMessage: (text: string) => void
}

export function TranslationDialog({
  cue,
  cues,
  hasAudio,
  hasVideo,
  onClose,
  onSelectCue,
  onApply,
  onSeekVideo,
  onCommand,
  onMessage,
}: TranslationDialogProps) {
  const skipWhitespace = getOptionBool('Tool/Translation Assistant/Skip Whitespace')
  const [blocks, setBlocks] = useState<DialogueBlock[]>(() => parseDialogueBlocks(cue.text))
  const [curBlock, setCurBlock] = useState(0)
  const [translated, setTranslated] = useState('')
  const [enablePreview, setEnablePreview] = useState(true)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const blocksRef = useRef(blocks)
  const applyBlocks = (next: DialogueBlock[]) => {
    blocksRef.current = next
    setBlocks(next)
  }
  /** 源码 switching_lines：自身导航引发的活动行变化不再重解析 */
  const switchingRef = useRef(false)
  /** 自身提交（file_change_connection.Block）：跳过 OnExternalCommit 的重解析 */
  const selfCommitRef = useRef<{ id: string; text: string } | null>(null)
  const lastRef = useRef({ id: cue.id, text: cue.text })
  // 行号语义对齐源码：UpdateDisplay 用 0 基 Row（上游 27c152262 起的行为，
  // 与 arch1t3cht fork 一致），OnExternalCommit 另用 Row + 1（见未完成计划备忘）
  const lineIndex = cues.findIndex((item) => item.id === cue.id)
  const lineCount = cues.length

  /** 源码 UpdateDisplay：清空译文、聚焦，勾选 Enable preview 时 Seek 到行首 */
  const updateDisplay = (line: SubtitleCue) => {
    setTranslated('')
    if (enablePreview && hasVideo) onSeekVideo(line.startMs)
    textAreaRef.current?.focus()
  }

  /**
   * 源码 NextBlock/PrevBlock：成功则同步活动行与显示；返回是否移动成功。
   * `fromBlock` 供外部活动行变化后的重新查找使用（此时 cur_block 已重置为 0）。
   */
  const stepBlock = (direction: 1 | -1, fromBlock = curBlock): boolean => {
    const position = stepDialogueBlock(
      cues,
      lineIndex,
      blocksRef.current,
      fromBlock,
      direction,
      skipWhitespace,
    )
    if (!position) return false
    const targetCue = cues[position.lineIndex]
    if (position.lineIndex !== lineIndex) {
      applyBlocks(parseDialogueBlocks(targetCue.text))
      switchingRef.current = true
      onSelectCue(targetCue.id)
    }
    setCurBlock(position.blockIndex)
    updateDisplay(targetCue)
    return true
  }

  /** 源码 Commit：换行统一替换为 \N，替换当前块后提交；next 时前进，否则仅刷新显示 */
  const commit = (next: boolean) => {
    const newValue = translated.replace(/\r\n/g, '\\N').replace(/\r/g, '\\N').replace(/\n/g, '\\N')
    const committed = commitDialogueBlock(blocksRef.current, curBlock, newValue)
    applyBlocks(committed.blocks)
    selfCommitRef.current = { id: cue.id, text: committed.text }
    onApply(cue.id, committed.text)
    if (next) {
      if (!stepBlock(1)) {
        onMessage(tPlain('No more lines to translate.'))
        onClose()
      }
    } else {
      updateDisplay(cue)
    }
  }

  /** 源码 InsertOriginal：在当前光标处插入原文（Scintilla AddText，光标落在插入文本后） */
  const insertOriginal = () => {
    const text = blocksRef.current[curBlock]?.text ?? ''
    const area = textAreaRef.current
    if (!area) {
      setTranslated((value) => value + text)
      return
    }
    const start = area.selectionStart
    const end = area.selectionEnd
    setTranslated(translated.slice(0, start) + text + translated.slice(end))
    requestAnimationFrame(() => area.setSelectionRange(start + text.length, start + text.length))
  }

  // 构造（源码构造函数）：解析活动行，首块不可翻译时向后查找（含跨行），
  // 全部找不到等价 NothingToTranslate（命令层提示 "There is nothing to translate in the file."）
  useEffect(() => {
    if (isBadBlock(blocksRef.current[0], skipWhitespace)) {
      if (!stepBlock(1, 0)) {
        onMessage(tPlain('There is nothing to translate in the file.'))
        onClose()
      }
    } else {
      updateDisplay(cue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅构造期执行一次
  }, [])

  // OnActiveLineChanged / OnExternalCommit(COMMIT_DIAG_TEXT)：外部行或文本变化时重解析
  useEffect(() => {
    const previous = lastRef.current
    lastRef.current = { id: cue.id, text: cue.text }
    if (previous.id === cue.id && previous.text === cue.text) return
    if (previous.id !== cue.id) {
      selfCommitRef.current = null
      if (switchingRef.current) {
        switchingRef.current = false
        return
      }
    } else {
      const committed = selfCommitRef.current
      if (committed && committed.id === cue.id && committed.text === cue.text) {
        selfCommitRef.current = null
        return
      }
    }
    applyBlocks(parseDialogueBlocks(cue.text))
    setCurBlock(0)
    if (isBadBlock(blocksRef.current[0], skipWhitespace)) {
      // 源码 OnActiveLineChanged → NextBlock → 失败提示 "No more lines to translate."
      if (!stepBlock(1, 0)) {
        onMessage(tPlain('No more lines to translate.'))
        onClose()
      }
      return
    }
    // 源码此分支不刷新显示（外部行变化时画面停留在旧行，属上游缺陷）；web 侧刷新
    updateDisplay(cue)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖为「活动行/文本」的原始值
  }, [cue.id, cue.text])

  // 对话框按键：wxEVT_KEY_DOWN + 译文控件 CHAR_HOOK → hotkey::check("Translation Assistant")
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    // 原生控件自行消费导航/激活键（wxCheckBox/wxButton 同理）
    if (target.matches('input[type="checkbox"], button, select')) return
    const command = commandForShortcut(
      shortcutFromKeyboardEvent(event.nativeEvent),
      'Translation Assistant',
    )
    if (!command || TRANSLATION_NATIVE_TEXT_COMMANDS.has(command)) return
    event.preventDefault()
    event.stopPropagation()
    switch (command) {
      case 'tool/translation_assistant/commit':
        commit(true)
        return
      case 'tool/translation_assistant/preview':
        commit(false)
        return
      case 'tool/translation_assistant/next':
        stepBlock(1)
        return
      case 'tool/translation_assistant/prev':
        stepBlock(-1)
        return
      case 'tool/translation_assistant/insert_original':
        insertOriginal()
        return
      default:
        onCommand(command)
    }
  }

  return (
    <Dialog
      title={tPlain('Translation Assistant')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
          <button
            onClick={() =>
              window.open(
                'https://aegisub.org/docs/latest/translation_assistant/',
                '_blank',
                'noopener',
              )
            }
          >
            {tPlain('Help')}
          </button>
        </>
      }
    >
      <div
        className="translation-assistant-body"
        data-shortcut-context="Translation Assistant"
        onKeyDown={handleKeyDown}
      >
        <fieldset className="dialog-fieldset translation-assistant-box">
          <legend>{tPlain('Original')}</legend>
          <span className="translation-line-number">
            {tFmt('Current line: %d/%d', lineIndex, lineCount)}
          </span>
          <div className="translation-original-text">
            {blocks.map((block, index) =>
              block.type === 'plain' && index === curBlock ? (
                // 源码 SetStyling(1)：当前块前景色 rgb(10, 60, 200)
                <span key={index} className="translation-original-active">
                  {block.text}
                </span>
              ) : (
                <span key={index}>{block.text}</span>
              ),
            )}
          </div>
        </fieldset>
        <fieldset className="dialog-fieldset translation-assistant-box">
          <legend>{tPlain('Translation')}</legend>
          <textarea
            ref={textAreaRef}
            className="translation-text"
            autoFocus
            value={translated}
            onChange={(event) => setTranslated(event.target.value)}
          />
        </fieldset>
        <div className="translation-assistant-row">
          <fieldset className="dialog-fieldset translation-assistant-keys">
            <legend>{tPlain('Keys')}</legend>
            <div className="translation-keys-grid">
              {TRANSLATION_ASSISTANT_KEYS.flatMap(([command, label]) => [
                <span key={`${command}-label`}>{tPlain(label)}</span>,
                <span key={`${command}-key`} className="translation-key">
                  {aegisubHotkeyStrFirst('Translation Assistant', command)}
                </span>,
              ])}
            </div>
            <label className="translation-preview-check">
              <input
                type="checkbox"
                checked={enablePreview}
                onChange={(event) => setEnablePreview(event.target.checked)}
              />
              {tPlain('Enable preview')}
            </label>
          </fieldset>
          <fieldset className="dialog-fieldset translation-assistant-actions">
            <legend>{tPlain('Actions')}</legend>
            <button
              disabled={!hasAudio}
              onClick={() => {
                onCommand('audio/play/selection')
                textAreaRef.current?.focus()
              }}
            >
              {tPlain('Play Audio')}
            </button>
            <button
              disabled={!hasVideo}
              onClick={() => {
                onCommand('video/play/line')
                textAreaRef.current?.focus()
              }}
            >
              {tPlain('Play Video')}
            </button>
          </fieldset>
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Resample Resolution（dialog_resample.cpp DialogResample）
// ---------------------------------------------------------------------------

/** Aspect Ratio Handling 选项（源码 ar_modes 顺序） */
const RESAMPLE_AR_MODE_LABELS = ['Stretch', 'Add borders', 'Remove borders', 'Manual']

/** wxSpinCtrl：文本无效时取下限，越界按范围钳位（整数） */
function clampSpin(raw: string, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export function ResampleDialog({
  document,
  hasVideo,
  videoWidth,
  videoHeight,
  onApply,
  onClose,
}: {
  document: SubtitleDocument
  hasVideo: boolean
  videoWidth: number
  videoHeight: number
  /** 一次 apply 覆盖整份文档（源码 resample + Commit 单步撤销，label "resolution resampling"） */
  onApply: (commands: CoreCommand[]) => void
  onClose: () => void
}) {
  // 构造期快照：script_w/script_h（GetResolution）与 script_mat（YCbCr Matrix to_effective）
  const script = getScriptResolution(document.scriptInfo)
  const scriptMat = ycbcrHeaderToEffective(
    parseYcbcrHeader(getScriptInfo(document.scriptInfo, 'YCbCr Matrix')),
  )
  // 视频矩阵：web 端无视频 YCbCr 元数据（等价源码默认构造的无效色彩空间），
  // 因此不做矩阵建议（两栏都停在空选项），"From video" 也只回填分辨率
  const [sourceX, setSourceX] = useState(script.width)
  const [sourceY, setSourceY] = useState(script.height)
  const [destX, setDestX] = useState(hasVideo ? videoWidth : script.width)
  const [destY, setDestY] = useState(hasVideo ? videoHeight : script.height)
  const [sourceMatrix, setSourceMatrix] = useState('')
  const [destMatrix, setDestMatrix] = useState('')
  const [symmetrical, setSymmetrical] = useState(true)
  const [arMode, setArMode] = useState(RESAMPLE_AR_STRETCH)
  // margin[LEFT, RIGHT, TOP, BOTTOM]（resolution_resampler.h 的 margin[4] 序）
  const [margin, setMargin] = useState<[number, number, number, number]>([0, 0, 0, 0])

  // UpdateButtons：|srcAR - dstAR| / dstAR > .01 才启用 AR 处理与 margin
  const arChanged = Math.abs(sourceX / sourceY - destX / destY) / (destX / destY) > 0.01
  const marginsEnabled = arChanged && arMode === RESAMPLE_AR_MANUAL
  const independentMargins = marginsEnabled && !symmetrical
  // OnMatrixChange：两端都解析出具体色彩空间才做转换
  const sourceHeader = parseYcbcrHeader(sourceMatrix)
  const destHeader = parseYcbcrHeader(destMatrix)
  const matrixConversion =
    sourceHeader.kind === 'colorspace' && destHeader.kind === 'colorspace'
      ? { src: sourceHeader.colorspace, dst: destHeader.colorspace }
      : null

  const changeMarginLeft = (raw: string) => {
    const value = clampSpin(raw, -9999, 9999)
    // OnMarginChange(LEFT, RIGHT)：勾选 Symmetrical 时 RIGHT 跟随 LEFT
    setMargin((current) => [value, symmetrical ? value : current[1], current[2], current[3]])
  }
  const changeMarginTop = (raw: string) => {
    const value = clampSpin(raw, -9999, 9999)
    setMargin((current) => [current[0], current[1], value, symmetrical ? value : current[3]])
  }
  const changeSymmetrical = (checked: boolean) => {
    setSymmetrical(checked)
    // OnSymmetrical：勾选时 RIGHT=LEFT、BOTTOM=TOP
    if (checked) setMargin((current) => [current[0], current[0], current[2], current[2]])
  }
  const setFromScript = () => {
    setSourceX(script.width)
    setSourceY(script.height)
    setSourceMatrix(MATRIX_OPTIONS[matrixOptionFromHeader(scriptMat)])
  }
  const setFromVideo = () => {
    setDestX(videoWidth)
    setDestY(videoHeight)
    // MatrixOptionFromHeader(无效视频矩阵) 恒为 0（空选项）
    setDestMatrix('')
  }

  const apply = () => {
    const commands = resampleCommands(document, {
      sourceX,
      sourceY,
      destX,
      destY,
      margin,
      arMode,
      matrixConversion,
    })
    if (commands.length) onApply(commands)
    onClose()
  }

  return (
    <Dialog
      title={tPlain('Resample Resolution')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>{tPlain('OK')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="resample-body">
        <fieldset className="dialog-fieldset">
          <legend>{tPlain('Source Resolution')}</legend>
          <div className="resample-res-row">
            <input
              type="number"
              className="resample-spin"
              min={1}
              max={999999}
              value={sourceX}
              aria-label={tPlain('Width')}
              onChange={(event) => setSourceX(clampSpin(event.target.value, 1, 999999))}
            />
            <span className="resample-times">×</span>
            <input
              type="number"
              className="resample-spin"
              min={1}
              max={999999}
              value={sourceY}
              aria-label={tPlain('Height')}
              onChange={(event) => setSourceY(clampSpin(event.target.value, 1, 999999))}
            />
            <button
              type="button"
              disabled={sourceX === script.width && sourceY === script.height}
              onClick={setFromScript}
            >
              {tPlain('From script')}
            </button>
          </div>
          <div className="resample-matrix-row">
            <span>{tPlain('YCbCr Matrix:')}</span>
            <select
              value={sourceMatrix}
              onChange={(event) => setSourceMatrix(event.target.value)}
              aria-label={tPlain('YCbCr Matrix:')}
            >
              {MATRIX_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <fieldset className="dialog-fieldset">
          <legend>{tPlain('Destination Resolution')}</legend>
          <div className="resample-res-row">
            <input
              type="number"
              className="resample-spin"
              min={1}
              max={999999}
              value={destX}
              aria-label={tPlain('Width')}
              onChange={(event) => setDestX(clampSpin(event.target.value, 1, 999999))}
            />
            <span className="resample-times">×</span>
            <input
              type="number"
              className="resample-spin"
              min={1}
              max={999999}
              value={destY}
              aria-label={tPlain('Height')}
              onChange={(event) => setDestY(clampSpin(event.target.value, 1, 999999))}
            />
            <button
              type="button"
              disabled={!hasVideo || (destX === videoWidth && destY === videoHeight)}
              onClick={setFromVideo}
            >
              {tPlain('From video')}
            </button>
          </div>
          <div className="resample-matrix-row">
            <span>{tPlain('YCbCr Matrix:')}</span>
            <select
              value={destMatrix}
              onChange={(event) => setDestMatrix(event.target.value)}
              aria-label={tPlain('YCbCr Matrix:')}
            >
              {MATRIX_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <fieldset className="dialog-fieldset">
          <legend>{tPlain('Aspect Ratio Handling')}</legend>
          <div className="resample-ar-row">
            {RESAMPLE_AR_MODE_LABELS.map((label, index) => (
              <label key={label}>
                <input
                  type="radio"
                  name="resample-ar-mode"
                  checked={arMode === index}
                  disabled={!arChanged}
                  onChange={() => setArMode(index)}
                />
                {tPlain(label)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="dialog-fieldset">
          <legend>{tPlain('Margin offset')}</legend>
          <div className="resample-margin-grid">
            <span />
            <input
              type="number"
              className="resample-spin"
              min={-9999}
              max={9999}
              value={margin[2]}
              disabled={!marginsEnabled}
              onChange={(event) => changeMarginTop(event.target.value)}
            />
            <span />
            <input
              type="number"
              className="resample-spin"
              min={-9999}
              max={9999}
              value={margin[0]}
              disabled={!marginsEnabled}
              onChange={(event) => changeMarginLeft(event.target.value)}
            />
            <label className="resample-symmetrical">
              <input
                type="checkbox"
                checked={symmetrical}
                disabled={!marginsEnabled}
                onChange={(event) => changeSymmetrical(event.target.checked)}
              />
              {tPlain('Symmetrical')}
            </label>
            <input
              type="number"
              className="resample-spin"
              min={-9999}
              max={9999}
              value={margin[1]}
              disabled={!independentMargins}
              onChange={(event) =>
                setMargin((current) => [
                  current[0],
                  clampSpin(event.target.value, -9999, 9999),
                  current[2],
                  current[3],
                ])
              }
            />
            <span />
            <input
              type="number"
              className="resample-spin"
              min={-9999}
              max={9999}
              value={margin[3]}
              disabled={!independentMargins}
              onChange={(event) =>
                setMargin((current) => [
                  current[0],
                  current[1],
                  current[2],
                  clampSpin(event.target.value, -9999, 9999),
                ])
              }
            />
            <span />
          </div>
        </fieldset>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={tPlain('About Aegisub Web')} onClose={onClose}>
      <div className="about-content">
        <img src={aegisubIconUrl('app_icon')} alt="Aegisub" width={64} height={64} />
        <h2>Aegisub Web</h2>
        <p>{tPlain('A browser port of Aegisub running on WebAssembly.')}</p>
        <dl className="about-details">
          <dt>{tPlain('Core')}</dt>
          <dd>Aegisub C++ (Emscripten WASM)</dd>
          <dt>{tPlain('Compatibility')}</dt>
          <dd>{tPlain('Aegisub menu / toolbar / hotkey data, ASS/SSA/SRT')}</dd>
          <dt>{tPlain('Website')}</dt>
          <dd>aegisub.org</dd>
          <dt>{tPlain('License')}</dt>
          <dd>BSD 3-clause (Aegisub)</dd>
        </dl>
      </div>
      <footer>
        <button onClick={onClose}>{tPlain('Close')}</button>
      </footer>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Video Details
// ---------------------------------------------------------------------------
interface VideoDetailsDialogProps {
  media: MediaSource
  durationMs: number
  /** 检测/配置的帧率（dialog_video_details.cpp FPS %.3f） */
  fps: number | null
  frameCount: number
  onClose: () => void
}

export function VideoDetailsDialog({
  media,
  durationMs,
  fps,
  frameCount,
  onClose,
}: VideoDetailsDialogProps) {
  const sizeMb = media.file ? (media.file.size / (1024 * 1024)).toFixed(1) : '?'
  const arText = (() => {
    const width = Number(media.dummy?.width) || 0
    const height = Number(media.dummy?.height) || 0
    if (!width || !height) return null
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
    const divisor = gcd(width, height) || 1
    return `${width / divisor}:${height / divisor}`
  })()
  return (
    <Dialog
      title={tPlain('Video Details')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{tPlain('Close')}</button>
        </>
      }
    >
      <dl className="about-details">
        <dt>{tPlain('File')}</dt>
        <dd>{media.name}</dd>
        <dt>{tPlain('FPS')}</dt>
        <dd>{fps ? fps.toFixed(3) : '?'}</dd>
        <dt>{tPlain('Resolution')}</dt>
        <dd>
          {media.dummy
            ? `${media.dummy.width} x ${media.dummy.height}${arText ? ` (${arText})` : ''}`
            : '?'}
        </dd>
        <dt>{tPlain('Length')}</dt>
        <dd>
          {frameCount} frame{frameCount === 1 ? '' : 's'} ({formatEditorTime(durationMs)})
        </dd>
        <dt>{tPlain('Type')}</dt>
        <dd>{media.file?.type || 'media'}</dd>
        <dt>{tPlain('Size')}</dt>
        <dd>{sizeMb} MB</dd>
      </dl>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Dummy Video（对应 Aegisub dialog_dummy_video.cpp）
// ---------------------------------------------------------------------------
interface DummyVideoDialogProps {
  onClose: () => void
  onApply: (options: DummyVideoOptions) => void
}

/** dialog_dummy_video.cpp 的分辨率快捷项 */
const DUMMY_RESOLUTIONS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: '640×480 (SD fullscreen)', width: 640, height: 480 },
  { name: '704×480 (SD anamorphic)', width: 704, height: 480 },
  { name: '640×360 (SD widescreen)', width: 640, height: 360 },
  { name: '704×396 (SD widescreen)', width: 704, height: 396 },
  { name: '640×352 (SD widescreen MOD16)', width: 640, height: 352 },
  { name: '704×400 (SD widescreen MOD16)', width: 704, height: 400 },
  { name: '1024×576 (SuperPAL widescreen)', width: 1024, height: 576 },
  { name: '1280×720 (HD 720p)', width: 1280, height: 720 },
  { name: '1920×1080 (FHD 1080p)', width: 1920, height: 1080 },
  { name: '2560×1440 (QHD 1440p)', width: 2560, height: 1440 },
  { name: '3840×2160 (4K UHD 2160p)', width: 3840, height: 2160 },
  { name: '1080×1920 (FHD vertical)', width: 1080, height: 1920 },
]

/** video_provider_dummy.cpp TryParseFramerate：先按 double，再按 num/den；失败返回 null */
function tryParseFramerate(text: string): Framerate | null {
  const value = text.trim()
  if (/^\+?(\d+(\.\d*)?|\.\d+)$/.test(value)) {
    const fps = Number.parseFloat(value)
    // Framerate(double)：fps < 0 或 > 1000 抛错（fps=0 为源码允许的边界）
    if (fps < 0 || fps > 1000) return null
    return Framerate.cfr(fps)
  }
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const num = Number.parseInt(parts[0].trim(), 10)
  const den = Number.parseInt(parts[1].trim(), 10)
  // Framerate(num, den)：分子分母须为正，且整数商不超过 1000
  if (!Number.isFinite(num) || !Number.isFinite(den)) return null
  if (num <= 0 || den <= 0 || Math.trunc(num / den) > 1000) return null
  return Framerate.cfr(num / den)
}

export function DummyVideoDialog({ onClose, onApply }: DummyVideoDialogProps) {
  const clampRange = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)))
  // 初始值来自 Options（源码 OPT_GET；确定时 OPT_SET 写回）
  const [width, setWidth] = useState(() =>
    clampRange(getOptionInt('Video/Dummy/Last/Width'), 1, 10000),
  )
  const [height, setHeight] = useState(() =>
    clampRange(getOptionInt('Video/Dummy/Last/Height'), 1, 10000),
  )
  const [fps, setFps] = useState(() => getOptionString('Video/Dummy/FPS String'))
  const [length, setLength] = useState(() =>
    clampRange(getOptionInt('Video/Dummy/Last/Length'), 2, 36_000_000),
  )
  const [color, setColor] = useState(() =>
    cssColorToHex(getOptionString('Colour/Video Dummy/Last Colour'), '#2fa3fe'),
  )
  const [pattern, setPattern] = useState(() => getOptionBool('Video/Dummy/Pattern'))

  // 帧率非法时 OK 禁用、时长显示 "-"（UpdateLengthDisplay）
  const framerate = useMemo(() => tryParseFramerate(fps), [fps])
  const resMatch = DUMMY_RESOLUTIONS.find((res) => res.width === width && res.height === height)

  const apply = () => {
    if (!framerate) return
    const w = clampRange(width, 1, 10000)
    const h = clampRange(height, 1, 10000)
    const frames = clampRange(length, 2, 36_000_000)
    const cssColor = hexToCssColor(color)
    setOption('Video/Dummy/FPS String', fps)
    setOption('Video/Dummy/Last/Width', w)
    setOption('Video/Dummy/Last/Height', h)
    setOption('Video/Dummy/Last/Length', frames)
    setOption('Colour/Video Dummy/Last Colour', cssColor)
    setOption('Video/Dummy/Pattern', pattern)
    onApply({
      width: w,
      height: h,
      lengthMs: framerate.timeAtFrame(frames),
      color: cssColor,
      pattern,
    })
    onClose()
  }

  return (
    <Dialog
      title={tPlain('Dummy video options')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply} disabled={!framerate}>
            {tPlain('OK')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          {tPlain('Video resolution:')}
          <select
            value={resMatch?.name ?? ''}
            onChange={(event) => {
              const res = DUMMY_RESOLUTIONS.find((item) => item.name === event.target.value)
              if (res) {
                setWidth(res.width)
                setHeight(res.height)
              }
            }}
          >
            <option value=""> </option>
            {DUMMY_RESOLUTIONS.map((res) => (
              <option key={res.name} value={res.name}>
                {res.name}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-row">
          <input
            type="number"
            min={1}
            max={10000}
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
            aria-label={tPlain('Width')}
          />
          <span>×</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={height}
            onChange={(event) => setHeight(Number(event.target.value))}
            aria-label={tPlain('Height')}
          />
        </div>
        <div className="dialog-row">
          <label>
            {tPlain('Color')}
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              style={{
                width: 24,
                padding: 0,
                border: '1px solid #aaa',
                background: 'transparent',
              }}
            />
          </label>
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={pattern}
              onChange={(event) => setPattern(event.target.checked)}
            />
            {tPlain('Checkerboard pattern')}
          </label>
        </div>
        <label>
          {tPlain('Frame rate (fps)')}
          <input
            type="text"
            value={fps}
            placeholder="24000/1001"
            onChange={(event) => setFps(event.target.value.replace(/[^0-9./]/g, ''))}
          />
        </label>
        <label>
          {tPlain('Duration (frames)')}
          <input
            type="number"
            min={2}
            max={36000000}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
          />
        </label>
        <p aria-live="polite">
          {tPlain('Resulting duration:')}{' '}
          {framerate ? formatVideoTime(framerate.timeAtFrame(length)) : '-'}
        </p>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Automation Manager（对应 Aegisub dialog_automation.cpp）
// ---------------------------------------------------------------------------
export interface AutomationScriptInfo {
  id: string
  name: string
  description: string
  filename: string
  macros: string[]
  error?: string
}

interface AutomationManagerDialogProps {
  scripts: AutomationScriptInfo[]
  onAdd: () => void
  onRemove: (id: string) => void
  onReload: (id: string) => void
  onClose: () => void
}

export function AutomationManagerDialog({
  scripts,
  onAdd,
  onRemove,
  onReload,
  onClose,
}: AutomationManagerDialogProps) {
  return (
    <Dialog
      title={tPlain('Automation Manager')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onAdd}>{tPlain('Add')}</button>
          <button onClick={onClose}>{tPlain('Close')}</button>
        </>
      }
    >
      <div
        className="automation-list"
        role="table"
        aria-label={tPlain('Loaded Automation scripts')}
      >
        <div className="automation-header automation-row" role="row">
          <span />
          <span>{tPlain('Name')}</span>
          <span>{tPlain('Filename')}</span>
          <span>{tPlain('Description')}</span>
        </div>
        {scripts.length === 0 && (
          <div className="automation-row automation-empty">
            {tPlain('No Automation scripts loaded')}
          </div>
        )}
        {scripts.map((script) => (
          <div
            className={`automation-row${script.error ? ' automation-error' : ''}`}
            role="row"
            key={script.id}
          >
            <span>L</span>
            <span title={script.macros.join(', ')}>
              {script.name}
              {script.macros.length > 0 && (
                <em className="automation-macros"> ({script.macros.length} macros)</em>
              )}
            </span>
            <span title={script.filename}>{script.filename}</span>
            <span title={script.error ?? script.description}>
              {script.error ?? script.description}
            </span>
            <span className="automation-actions">
              <button onClick={() => onReload(script.id)} title={tPlain('Reload')}>
                {tPlain('Reload')}
              </button>
              <button onClick={() => onRemove(script.id)} title={tPlain('Remove')}>
                {tPlain('Remove')}
              </button>
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Select Lines（对应 Aegisub dialog_selection.cpp）
// ---------------------------------------------------------------------------
export interface SelectLinesSettings {
  matchText: string
  matchCase: boolean
  mode: 'exact' | 'contains' | 'regexp'
  field: 'text' | 'style' | 'actor' | 'effect'
  /** Doesn't Match */
  invert: boolean
  dialogue: boolean
  comments: boolean
  action: 'set' | 'add' | 'sub' | 'intersect'
}

interface SelectLinesDialogProps {
  onClose: () => void
  onApply: (settings: SelectLinesSettings, close: boolean) => void
}

export function SelectLinesDialog({ onClose, onApply }: SelectLinesDialogProps) {
  // 初值来自 Options（dialog_selection.cpp 构造时 OPT_GET）
  const [matchText, setMatchText] = useState(() => getOptionString('Tool/Select Lines/Text'))
  const [matchCase, setMatchCase] = useState(() => getOptionBool('Tool/Select Lines/Match/Case'))
  const [invert, setInvert] = useState(() => getOptionInt('Tool/Select Lines/Condition') === 1)
  const [mode, setMode] = useState<SelectLinesSettings['mode']>((): SelectLinesSettings['mode'] => {
    const value = getOptionInt('Tool/Select Lines/Mode')
    return value === 0 ? 'exact' : value === 2 ? 'regexp' : 'contains'
  })
  const [field, setField] = useState<SelectLinesSettings['field']>(
    (): SelectLinesSettings['field'] => {
      const value = getOptionInt('Tool/Select Lines/Field')
      return value === 1 ? 'style' : value === 2 ? 'actor' : value === 3 ? 'effect' : 'text'
    },
  )
  const [dialogue, setDialogue] = useState(() => getOptionBool('Tool/Select Lines/Match/Dialogue'))
  const [comments, setComments] = useState(() => getOptionBool('Tool/Select Lines/Match/Comment'))
  const [action, setAction] = useState<SelectLinesSettings['action']>(
    (): SelectLinesSettings['action'] => {
      const value = getOptionInt('Tool/Select Lines/Action')
      return value === 1 ? 'add' : value === 2 ? 'sub' : value === 3 ? 'intersect' : 'set'
    },
  )

  // 关闭时写回 Options（dialog_selection.cpp 析构 OPT_SET：无论 OK/Cancel 都保存）
  const latestRef = useRef({
    matchText: '',
    matchCase: false,
    invert: false,
    mode: 'contains' as SelectLinesSettings['mode'],
    field: 'text' as SelectLinesSettings['field'],
    dialogue: true,
    comments: false,
    action: 'set' as SelectLinesSettings['action'],
  })
  useEffect(() => {
    latestRef.current = { matchText, matchCase, invert, mode, field, dialogue, comments, action }
  })
  useEffect(
    () => () => {
      const value = latestRef.current
      setOption('Tool/Select Lines/Text', value.matchText)
      setOption('Tool/Select Lines/Condition', value.invert ? 1 : 0)
      setOption('Tool/Select Lines/Field', { text: 0, style: 1, actor: 2, effect: 3 }[value.field])
      setOption('Tool/Select Lines/Action', { set: 0, add: 1, sub: 2, intersect: 3 }[value.action])
      setOption('Tool/Select Lines/Mode', { exact: 0, contains: 1, regexp: 2 }[value.mode])
      setOption('Tool/Select Lines/Match/Case', value.matchCase)
      setOption('Tool/Select Lines/Match/Dialogue', value.dialogue)
      setOption('Tool/Select Lines/Match/Comment', value.comments)
    },
    [],
  )

  // OnDialogueCheckbox：Dialogues/Comments 至少一项勾选
  const toggleDialogue = (value: boolean) => {
    if (!value && !comments) return
    setDialogue(value)
  }
  const toggleComments = (value: boolean) => {
    if (!value && !dialogue) return
    setComments(value)
  }

  const apply = (close: boolean) => {
    if (!matchText) return
    onApply({ matchText, matchCase, mode, field, invert, dialogue, comments, action }, close)
  }

  return (
    <Dialog
      title={tPlain('Select Lines')}
      onClose={onClose}
      footer={
        // CreateButtonSizer(wxOK | wxCANCEL | wxAPPLY | wxHELP)：顺序 OK | Cancel | Apply（Help 无对应帮助页省略）
        <>
          <button onClick={() => apply(true)} disabled={!matchText}>
            {tPlain('OK')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
          <button onClick={() => apply(false)} disabled={!matchText}>
            {tPlain('Apply')}
          </button>
        </>
      }
    >
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('Match')}</legend>
        <div className="dialog-row">
          <label className="dialog-check">
            <input
              type="radio"
              name="select-condition"
              checked={!invert}
              onChange={() => setInvert(false)}
            />{' '}
            {tPlain('Matches')}
          </label>
          <label className="dialog-check">
            <input
              type="radio"
              name="select-condition"
              checked={invert}
              onChange={() => setInvert(true)}
            />{' '}
            {tPlain("Doesn't Match")}
          </label>
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => setMatchCase(event.target.checked)}
            />{' '}
            {tPlain('Match case')}
          </label>
        </div>
        <input
          autoFocus
          value={matchText}
          onChange={(event) => setMatchText(event.target.value)}
          aria-label={tPlain('Match text')}
        />
      </fieldset>
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('Mode')}</legend>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-mode"
            checked={mode === 'exact'}
            onChange={() => setMode('exact')}
          />{' '}
          {tPlain('Exact match')}
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-mode"
            checked={mode === 'contains'}
            onChange={() => setMode('contains')}
          />{' '}
          {tPlain('Contains')}
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-mode"
            checked={mode === 'regexp'}
            onChange={() => setMode('regexp')}
          />{' '}
          {tPlain('Regular Expression match')}
        </label>
      </fieldset>
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('In Field')}</legend>
        <div className="dialog-row">
          <label className="dialog-check">
            <input
              type="radio"
              name="select-field"
              checked={field === 'text'}
              onChange={() => setField('text')}
            />{' '}
            {tPlain('Text')}
          </label>
          <label className="dialog-check">
            <input
              type="radio"
              name="select-field"
              checked={field === 'style'}
              onChange={() => setField('style')}
            />{' '}
            {tPlain('Style')}
          </label>
          <label className="dialog-check">
            <input
              type="radio"
              name="select-field"
              checked={field === 'actor'}
              onChange={() => setField('actor')}
            />{' '}
            {tPlain('Actor')}
          </label>
          <label className="dialog-check">
            <input
              type="radio"
              name="select-field"
              checked={field === 'effect'}
              onChange={() => setField('effect')}
            />{' '}
            {tPlain('Effect')}
          </label>
        </div>
      </fieldset>
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('Match dialogues/comments')}</legend>
        <div className="dialog-row">
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={dialogue}
              onChange={(event) => toggleDialogue(event.target.checked)}
            />{' '}
            {tPlain('Dialogues')}
          </label>
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={comments}
              onChange={(event) => toggleComments(event.target.checked)}
            />{' '}
            {tPlain('Comments')}
          </label>
        </div>
      </fieldset>
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('Action')}</legend>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-action"
            checked={action === 'set'}
            onChange={() => setAction('set')}
          />{' '}
          {tPlain('Set selection')}
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-action"
            checked={action === 'add'}
            onChange={() => setAction('add')}
          />{' '}
          {tPlain('Add to selection')}
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-action"
            checked={action === 'sub'}
            onChange={() => setAction('sub')}
          />{' '}
          {tPlain('Subtract from selection')}
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="select-action"
            checked={action === 'intersect'}
            onChange={() => setAction('intersect')}
          />{' '}
          {tPlain('Intersect with selection')}
        </label>
      </fieldset>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Timing Post-Processor（dialog_timing_processor.cpp）
// ---------------------------------------------------------------------------
interface TimingProcessorDialogProps {
  cues: SubtitleCue[]
  styles: string[]
  selectedIds: string[]
  keyframes: number[]
  frameCount: number
  hasVideo: boolean
  frameRate: Framerate
  onClose: () => void
  onApply: (commands: CoreCommand[], label: string) => void
}

export function TimingProcessorDialog({
  cues,
  styles,
  selectedIds,
  keyframes,
  frameCount,
  hasVideo,
  frameRate,
  onClose,
  onApply,
}: TimingProcessorDialogProps) {
  // 关键帧仅在关键帧与 timecodes 都可用时可吸附（keysAvailable）
  const keysAvailable = keyframes.length > 0 && frameRate.isLoaded()

  // 初值来自 Options（dialog_timing_processor.cpp 构造时 OPT_GET；样式默认全选 = CheckAll(true)）
  const [checkedStyles, setCheckedStyles] = useState<Set<string>>(() => new Set(styles))
  const [onlySelection, setOnlySelection] = useState(() =>
    getOptionBool('Tool/Timing Post Processor/Only Selection'),
  )
  const [enableLeadIn, setEnableLeadIn] = useState(() =>
    getOptionBool('Tool/Timing Post Processor/Enable/Lead/IN'),
  )
  const [leadIn, setLeadIn] = useState(() => getOptionInt('Tool/Timing Post Processor/Lead/IN'))
  const [enableLeadOut, setEnableLeadOut] = useState(() =>
    getOptionBool('Tool/Timing Post Processor/Enable/Lead/OUT'),
  )
  const [leadOut, setLeadOut] = useState(() => getOptionInt('Tool/Timing Post Processor/Lead/OUT'))
  const [enableAdjacent, setEnableAdjacent] = useState(() =>
    getOptionBool('Tool/Timing Post Processor/Enable/Adjacent'),
  )
  const [adjGap, setAdjGap] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Adjacent Gap'),
  )
  const [adjOverlap, setAdjOverlap] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Adjacent Overlap'),
  )
  // wxSlider 取 int(GetDouble()*100)（截断）
  const [adjacentBias, setAdjacentBias] = useState(() =>
    Math.max(
      0,
      Math.min(100, Math.trunc(getOptionDouble('Tool/Timing Post Processor/Adjacent Bias') * 100)),
    ),
  )
  const [enableKeyframes, setEnableKeyframes] = useState(
    () => keysAvailable && getOptionBool('Tool/Timing Post Processor/Enable/Keyframe'),
  )
  const [beforeStart, setBeforeStart] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Key Start Before'),
  )
  const [afterStart, setAfterStart] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Key Start After'),
  )
  const [beforeEnd, setBeforeEnd] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Key End Before'),
  )
  const [afterEnd, setAfterEnd] = useState(() =>
    getOptionInt('Tool/Timing Post Processor/Threshold/Key End After'),
  )
  const [error, setError] = useState<string | null>(null)

  const toggleStyle = (style: string, checked: boolean) => {
    setCheckedStyles((current) => {
      const next = new Set(current)
      if (checked) next.add(style)
      else next.delete(style)
      return next
    })
  }

  // UpdateControls：任一功能启用且至少勾选一个样式时 OK 可用
  const applyEnabled =
    checkedStyles.size > 0 && (enableLeadIn || enableLeadOut || enableKeyframes || enableAdjacent)

  const apply = () => {
    // OnApply：先写回全部选项再处理（源码 OK 时才保存）
    setOption('Tool/Timing Post Processor/Lead/IN', leadIn)
    setOption('Tool/Timing Post Processor/Lead/OUT', leadOut)
    setOption('Tool/Timing Post Processor/Threshold/Key Start Before', beforeStart)
    setOption('Tool/Timing Post Processor/Threshold/Key Start After', afterStart)
    setOption('Tool/Timing Post Processor/Threshold/Key End Before', beforeEnd)
    setOption('Tool/Timing Post Processor/Threshold/Key End After', afterEnd)
    setOption('Tool/Timing Post Processor/Threshold/Adjacent Gap', adjGap)
    setOption('Tool/Timing Post Processor/Threshold/Adjacent Overlap', adjOverlap)
    setOption('Tool/Timing Post Processor/Adjacent Bias', adjacentBias / 100)
    setOption('Tool/Timing Post Processor/Enable/Lead/IN', enableLeadIn)
    setOption('Tool/Timing Post Processor/Enable/Lead/OUT', enableLeadOut)
    if (keysAvailable) setOption('Tool/Timing Post Processor/Enable/Keyframe', enableKeyframes)
    setOption('Tool/Timing Post Processor/Enable/Adjacent', enableAdjacent)
    setOption('Tool/Timing Post Processor/Only Selection', onlySelection)

    const result = processTiming({
      cues,
      selectedIds: new Set(selectedIds),
      checkedStyles,
      options: {
        leadIn,
        leadOut,
        beforeStart,
        afterStart,
        beforeEnd,
        afterEnd,
        adjGap,
        adjOverlap,
        adjacentBias: adjacentBias / 100,
        enableLeadIn,
        enableLeadOut,
        enableKeyframes,
        enableAdjacent,
        onlySelection,
      },
      keyframes,
      frameCount,
      hasVideo,
      frameRate,
    })
    // 源码弹 wxMessageBox 后同样中止不应用（fmt_tl）
    if (result.invalidRow !== null) {
      setError(
        tFmt(
          'One of the lines in the file (%i) has negative duration. Aborting.',
          result.invalidRow,
        ),
      )
      return
    }
    if (result.patches.length > 0) {
      onApply(
        result.patches.map((patch) => ({
          type: 'updateCue' as const,
          id: patch.id,
          patch: { startMs: patch.startMs, endMs: patch.endMs },
        })),
        'timing processor',
      )
    }
    onClose()
  }

  /** 整数输入（wxIntegerValidator SetMin(0)） */
  const numberInput = (
    value: number,
    onChange: (value: number) => void,
    label: string,
    disabled: boolean,
  ) => (
    <label className="timing-number">
      {label}
      <input
        type="number"
        min={0}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Math.max(0, Math.round(Number(event.target.value) || 0)))}
      />
    </label>
  )

  return (
    <Dialog
      title={tPlain('Timing Post-Processor')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply} disabled={!applyEnabled}>
            {tPlain('OK')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="timing-columns">
        <fieldset className="dialog-fieldset timing-styles">
          <legend>{tPlain('Apply to styles')}</legend>
          <div
            className="dialog-checklist"
            title={tPlain('Select styles to process. Unchecked ones will be ignored.')}
          >
            {styles.map((style) => (
              <label key={style} className="dialog-check">
                <input
                  type="checkbox"
                  checked={checkedStyles.has(style)}
                  onChange={(event) => toggleStyle(style, event.target.checked)}
                />{' '}
                {style}
              </label>
            ))}
          </div>
          <div className="dialog-row">
            <button onClick={() => setCheckedStyles(new Set(styles))}>{tPlain('All')}</button>
            <button onClick={() => setCheckedStyles(new Set())}>{tPlain('None')}</button>
          </div>
        </fieldset>
        <div className="timing-options">
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Options')}</legend>
            <label className="dialog-check">
              <input
                type="checkbox"
                checked={onlySelection}
                onChange={(event) => setOnlySelection(event.target.checked)}
              />{' '}
              {tPlain('Affect selection only')}
            </label>
          </fieldset>
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Lead-in/Lead-out')}</legend>
            {/* 源码为单行横排：两组"启用勾选 + 毫秒输入"并排（LeadSizer wxHORIZONTAL） */}
            <div className="dialog-row">
              <label className="dialog-check" title={tPlain('Enable adding of lead-ins to lines')}>
                <input
                  type="checkbox"
                  checked={enableLeadIn}
                  onChange={(event) => setEnableLeadIn(event.target.checked)}
                />{' '}
                {tPlain('Add lead in:')}
              </label>
              {numberInput(leadIn, setLeadIn, '', !enableLeadIn)}
              <label className="dialog-check" title={tPlain('Enable adding of lead-outs to lines')}>
                <input
                  type="checkbox"
                  checked={enableLeadOut}
                  onChange={(event) => setEnableLeadOut(event.target.checked)}
                />{' '}
                {tPlain('Add lead out:')}
              </label>
              {numberInput(leadOut, setLeadOut, '', !enableLeadOut)}
            </div>
          </fieldset>
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Make adjacent subtitles continuous')}</legend>
            <label
              className="dialog-check"
              title={tPlain(
                'Enable snapping of subtitles together if they are within a certain distance of each other',
              )}
            >
              <input
                type="checkbox"
                checked={enableAdjacent}
                onChange={(event) => setEnableAdjacent(event.target.checked)}
              />{' '}
              {tPlain('Enable')}
            </label>
            <div className="dialog-row">
              {numberInput(adjGap, setAdjGap, tPlain('Max gap:'), !enableAdjacent)}
              {numberInput(adjOverlap, setAdjOverlap, tPlain('Max overlap:'), !enableAdjacent)}
            </div>
            <div
              className="dialog-row"
              title={tPlain(
                'Sets how to set the adjoining of lines. If set totally to left, it will extend or shrink start time of the second line; if totally to right, it will extend or shrink the end time of the first line.',
              )}
            >
              <span>{tPlain('Bias: Start <- ')}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={adjacentBias}
                disabled={!enableAdjacent}
                onChange={(event) => setAdjacentBias(Number(event.target.value))}
              />
              <span>{tPlain(' -> End')}</span>
            </div>
          </fieldset>
          <fieldset className="dialog-fieldset">
            <legend>{tPlain('Keyframe snapping')}</legend>
            <label
              className="dialog-check"
              title={tPlain(
                'Enable snapping of subtitles to nearest keyframe, if distance is within threshold',
              )}
            >
              <input
                type="checkbox"
                checked={enableKeyframes}
                disabled={!keysAvailable}
                onChange={(event) => setEnableKeyframes(event.target.checked)}
              />{' '}
              {tPlain('Enable')}
            </label>
            <div className="timing-thresholds">
              {numberInput(
                beforeStart,
                setBeforeStart,
                tPlain('Starts before thres.:'),
                !enableKeyframes,
              )}
              {numberInput(
                afterStart,
                setAfterStart,
                tPlain('Starts after thres.:'),
                !enableKeyframes,
              )}
              {numberInput(
                beforeEnd,
                setBeforeEnd,
                tPlain('Ends before thres.:'),
                !enableKeyframes,
              )}
              {numberInput(afterEnd, setAfterEnd, tPlain('Ends after thres.:'), !enableKeyframes)}
            </div>
          </fieldset>
        </div>
      </div>
      {error && <p className="dialog-error">{error}</p>}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Export Subtitles（对应 Aegisub dialog_export.cpp 的 Web 版子集）
// ---------------------------------------------------------------------------
export interface ExportOptions {
  format: 'ass' | 'srt'
  includeComments: boolean
}

interface ExportSubtitlesDialogProps {
  onClose: () => void
  onApply: (options: ExportOptions) => void
}

export function ExportSubtitlesDialog({ onClose, onApply }: ExportSubtitlesDialogProps) {
  const [format, setFormat] = useState<ExportOptions['format']>('ass')
  const [includeComments, setIncludeComments] = useState(false)
  return (
    <Dialog
      title={tPlain('Export Subtitles')}
      onClose={onClose}
      footer={
        <>
          <button onClick={() => onApply({ format, includeComments })}>{tPlain('Export')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields">
        <fieldset className="dialog-fieldset">
          <legend>{tPlain('Format')}</legend>
          <label className="dialog-check">
            <input
              type="radio"
              name="export-format"
              checked={format === 'ass'}
              onChange={() => setFormat('ass')}
            />{' '}
            {tPlain('Advanced SubStation Alpha (ASS)')}
          </label>
          <label className="dialog-check">
            <input
              type="radio"
              name="export-format"
              checked={format === 'srt'}
              onChange={() => setFormat('srt')}
            />{' '}
            {tPlain('SubRip (SRT)')}
          </label>
        </fieldset>
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={includeComments}
            onChange={(event) => setIncludeComments(event.target.checked)}
          />
          {tPlain('Include comment lines')}
        </label>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Language（对应 Aegisub wxLocale::PickLanguage，app.cpp OnLanguage）
// ---------------------------------------------------------------------------

/** 当前生效语言：App/Language 未配置时与启动探测一致 */
function currentLocaleCode(): string {
  return getLocale() || detectDefaultLocale(availableLocales)
}

export function LanguageDialog({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<string>(currentLocaleCode)
  return (
    <Dialog
      title={tPlain('Language')}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={() => {
              if (selected === currentLocaleCode()) {
                onClose()
                return
              }
              storeLanguage(selected)
              void setLocale(selected)
              onClose()
            }}
          >
            {t('OK')}
          </button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </>
      }
    >
      <div
        className="dialog-fields language-dialog-list"
        role="listbox"
        aria-label={tPlain('Language')}
      >
        {availableLocales.map((code) => (
          <label className="dialog-check" key={code}>
            <input
              type="radio"
              name="language-choice"
              checked={selected === code}
              onChange={() => setSelected(code)}
            />
            {localeLabel(code)}
            <span className="language-dialog-code">{code}</span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 视频首帧偏移（web 专属：主线归一化语义的载入提醒与导出保留偏移选择，
// 见 vfr.ts serializeTimecodesKeepOffset 注释）
// ---------------------------------------------------------------------------

/** 载入视频时首帧偏移显著（> 每帧时长 1/5）的提醒 */
export function VideoOffsetNoticeDialog({
  offsetMs,
  frameDurationMs,
  onClose,
}: {
  offsetMs: number
  frameDurationMs: number
  onClose: () => void
}) {
  return (
    <Dialog
      title={tPlain('Video first-frame offset')}
      onClose={onClose}
      footer={<button onClick={onClose}>{t('OK')}</button>}
    >
      <div className="dialog-fields">
        <p>
          {tFmt(
            'The first frame of this video starts at %s ms (frame duration ≈ %s ms).',
            String(offsetMs),
            frameDurationMs.toFixed(2),
          )}
        </p>
        <p>
          {tPlain(
            'Timecodes are normalized to start at 0 ms when loaded (upstream Aegisub semantics). You can keep this offset when exporting timecodes.',
          )}
        </p>
      </div>
    </Dialog>
  )
}

/** 导出时间码时视频存在首帧偏移：让用户选择保留偏移或归一化到 0 */
export function TimecodesOffsetDialog({
  offsetMs,
  onChoice,
  onClose,
}: {
  offsetMs: number
  onChoice: (keepOffset: boolean) => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={tPlain('Save Timecodes File...')}
      onClose={onClose}
      footer={
        <>
          <button onClick={() => onChoice(true)}>{tPlain('Keep offset')}</button>
          <button onClick={() => onChoice(false)}>{tPlain('Normalize to 0')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields">
        <p>
          {tFmt(
            'The video has a first-frame offset of %s ms. Keep it in the exported timecodes file?',
            String(offsetMs),
          )}
        </p>
        <p>
          {tPlain(
            'Keep offset: times start at the raw first-frame PTS (arch1t3cht fork behavior).',
          )}
        </p>
        <p>
          {tPlain(
            'Normalize to 0: subtract the offset so frame 0 starts at 0 ms (upstream Aegisub behavior).',
          )}
        </p>
      </div>
    </Dialog>
  )
}
