import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { getOptionBool, getOptionInt, getOptionString, setOption } from '../../config/options'
import { formatEditorTime, formatVideoTime } from '../../core/time'
import type { CoreCommand, SubtitleCue, SubtitleStyle } from '../../core/types'
import { Framerate } from '../../core/vfr'
import type { DummyVideoOptions, MediaSource } from '../../platform/types'
import { listFontFaces } from '../../storage/fontStore'
import { aegisubIconUrl } from '../aegisubIcons'
import { cssColorToHex, hexToCssColor } from '../color'
import {
  availableLocales,
  detectDefaultLocale,
  getLocale,
  localeLabel,
  setLocale,
  storeLanguage,
  t,
  tPlain,
} from '../i18n'

interface DialogProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}

export function Dialog({ title, onClose, children, footer }: DialogProps) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
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
export interface ShiftTimesOptions {
  byMs: boolean
  amount: number
  backward: boolean
  selectedOnly: boolean
}

interface ShiftTimesDialogProps {
  cues: SubtitleCue[]
  selectedIds: string[]
  onClose: () => void
  onApply: (commands: CoreCommand[], label: string) => void
}

export function ShiftTimesDialog({ cues, selectedIds, onClose, onApply }: ShiftTimesDialogProps) {
  // 初值来自 Options（dialog_shift_times.cpp 构造时 OPT_GET；Affect 1=Selected rows，2=onward 归入 selected）
  const [byMs, setByMs] = useState(() => getOptionBool('Tool/Shift Times/ByTime'))
  const [amount, setAmount] = useState(() => getOptionInt('Tool/Shift Times/Time'))
  const [frames, setFrames] = useState(() => getOptionInt('Tool/Shift Times/Frames'))
  const [backward, setBackward] = useState(() => !getOptionBool('Tool/Shift Times/Direction'))
  const [selectedOnly, setSelectedOnly] = useState(
    () => getOptionInt('Tool/Shift Times/Affect') > 0,
  )

  // 关闭时写回 Options（dialog_shift_times.cpp 析构 OPT_SET：无论 OK/Cancel 都保存）
  const latestRef = useRef({
    byMs: true,
    amount: 0,
    frames: 0,
    backward: false,
    selectedOnly: false,
  })
  useEffect(() => {
    latestRef.current = { byMs, amount, frames, backward, selectedOnly }
  })
  useEffect(
    () => () => {
      const value = latestRef.current
      setOption('Tool/Shift Times/Time', Math.round(value.amount) || 0)
      setOption('Tool/Shift Times/Frames', Math.round(value.frames) || 0)
      setOption('Tool/Shift Times/ByTime', value.byMs)
      setOption('Tool/Shift Times/Direction', !value.backward)
      setOption('Tool/Shift Times/Affect', value.selectedOnly ? 1 : 0)
    },
    [],
  )

  const apply = () => {
    const shift = byMs ? amount : frames * 10 // 近似 10ms/帧（Aegisub 默认帧率处理）
    const signed = backward ? -shift : shift
    if (!signed) return
    const selSet = new Set(selectedIds)
    const targets = cues.filter((cue) => !selectedOnly || selSet.has(cue.id))
    const commands: CoreCommand[] = targets.map((cue) => ({
      type: 'updateCue',
      id: cue.id,
      patch: {
        startMs: Math.max(0, cue.startMs + signed),
        endMs: Math.max(0, cue.endMs + signed),
      },
    }))
    onApply(commands, `Shift times ${backward ? 'backward' : 'forward'}`)
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
      <div className="dialog-fields">
        <label>
          {tPlain('Preset')}
          <select
            value={byMs ? 'ms' : 'frames'}
            onChange={(event) => setByMs(event.target.value === 'ms')}
          >
            <option value="ms">{tPlain('Custom (milliseconds)')}</option>
            <option value="frames">{tPlain('Custom (frames)')}</option>
          </select>
        </label>
        {byMs ? (
          <label>
            {tPlain('Shift by (ms)')}
            <input
              type="number"
              value={amount}
              onChange={(event) => setAmount(Number(event.target.value))}
              autoFocus
            />
          </label>
        ) : (
          <label>
            {tPlain('Shift by (frames)')}
            <input
              type="number"
              value={frames}
              onChange={(event) => setFrames(Number(event.target.value))}
              autoFocus
            />
          </label>
        )}
        <label>
          {tPlain('Direction')}
          <select
            value={backward ? 'back' : 'forward'}
            onChange={(event) => setBackward(event.target.value === 'back')}
          >
            <option value="forward">{tPlain('Forward')}</option>
            <option value="back">{tPlain('Backward')}</option>
          </select>
        </label>
        <label>
          {tPlain('Apply to')}
          <select
            value={selectedOnly ? 'selected' : 'all'}
            onChange={(event) => setSelectedOnly(event.target.value === 'selected')}
          >
            <option value="all">{tPlain('All lines')}</option>
            <option value="selected">{tPlain('Selected lines only')}</option>
          </select>
        </label>
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
// Styling Assistant（对应 Aegisub dialog_styling_assistant.cpp 的核心工作流）
// ---------------------------------------------------------------------------
interface StylingAssistantDialogProps {
  cue: SubtitleCue
  styles: SubtitleStyle[]
  onClose: () => void
  onApply: (style: string, next: boolean) => void
  onPrevious: () => void
  onPlay: () => void
}

export function StylingAssistantDialog({
  cue,
  styles,
  onClose,
  onApply,
  onPrevious,
  onPlay,
}: StylingAssistantDialogProps) {
  const [style, setStyle] = useState(cue.style)
  const commit = (next: boolean) => {
    if (styles.some((item) => item.name === style)) onApply(style, next)
  }

  return (
    <Dialog
      title={tPlain('Styling Assistant')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onPrevious}>{tPlain('Previous')}</button>
          <button onClick={onPlay}>{tPlain('Play')}</button>
          <button onClick={() => commit(false)}>{tPlain('Apply')}</button>
          <button onClick={() => commit(true)}>{tPlain('Apply and Next')}</button>
          <button onClick={onClose}>{tPlain('Close')}</button>
        </>
      }
    >
      <div className="styling-assistant-body" data-shortcut-context="Styling Assistant">
        <textarea readOnly value={cue.text} aria-label={tPlain('Subtitle text')} />
        <label>
          {tPlain('Style')}
          <input
            autoFocus
            list="styling-assistant-styles"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit(true)
              }
            }}
          />
          <datalist id="styling-assistant-styles">
            {styles.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
        </label>
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

export function TranslationDialog({
  cue,
  onApply,
  onClose,
}: {
  cue: SubtitleCue
  onApply: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(cue.text.replace(/\{[^}]*\}/g, ''))
  const apply = () => {
    onApply(text.replace(/\r?\n/g, '\\N'))
    onClose()
  }
  return (
    <Dialog
      title={tPlain('Translation Assistant')}
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>{tPlain('Apply')}</button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="translation-dialog-body">
        <label>
          {tPlain('Original')}
          <textarea readOnly value={cue.text} />
        </label>
        <label>
          {tPlain('Translation')}
          <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
    </Dialog>
  )
}

export function ResampleDialog({
  scriptInfo,
  onApply,
  onClose,
}: {
  scriptInfo: Record<string, string>
  onApply: (patch: Record<string, string>) => void
  onClose: () => void
}) {
  const [width, setWidth] = useState(Number(scriptInfo.PlayResX) || 1920)
  const [height, setHeight] = useState(Number(scriptInfo.PlayResY) || 1080)
  return (
    <Dialog
      title={tPlain('Resample Resolution')}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={() => {
              onApply({
                PlayResX: String(Math.max(1, width)),
                PlayResY: String(Math.max(1, height)),
              })
              onClose()
            }}
          >
            {tPlain('OK')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          {tPlain('Width')}
          <input
            type="number"
            min={1}
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          />
        </label>
        <label>
          {tPlain('Height')}
          <input
            type="number"
            min={1}
            value={height}
            onChange={(event) => setHeight(Number(event.target.value))}
          />
        </label>
        <p>
          {tPlain(
            'Script resolution metadata will be updated. Full override-tag coordinate resampling is not yet enabled.',
          )}
        </p>
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
        <>
          <button onClick={() => apply(true)} disabled={!matchText}>
            {tPlain('OK')}
          </button>
          <button onClick={() => apply(false)} disabled={!matchText}>
            {tPlain('Apply')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
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
      </fieldset>
      <fieldset className="dialog-fieldset">
        <legend>{tPlain('Match dialogues/comments')}</legend>
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
