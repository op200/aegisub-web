import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import {
  getOptionBool,
  getOptionInt,
  getOptionString,
  setOption,
  useOptionsVersion,
} from '../../config/options'
import {
  assOverrideColor,
  blockAtPos,
  findTag,
  normalizePos,
  parseBlocks,
  setTag,
  tagBool,
  tagColorHex,
} from '../../core/assTags'
import { formatEditorTime, parseEditorTime } from '../../core/time'
import type { SubtitleCue, SubtitleStyle } from '../../core/types'
import { Framerate } from '../../core/vfr'
import { listFontFaces } from '../../storage/fontStore'
import { aegisubIconUrl } from '../aegisubIcons'
import {
  getSyntaxColors,
  tokenizeAss,
  type AssHighlightSegment,
  type AssSyntaxStyle,
  type AssSyntaxType,
} from '../assHighlight'
import { assColorToHex } from '../color'
import { editCursorState } from '../commandRegistry'
import { COMMANDS, commandTooltip } from '../commands'
import { tPlain } from '../i18n'
import { LUA_BLOCK_BACKGROUND, LUA_BLOCK_CARET } from '../luaHighlight'
import { useSystemTheme } from '../theme'
import { Dialog } from './dialogs'
import { MenuPopup } from './MenuPopup'

const EDIT_ICON = (name: string) => aegisubIconUrl(`${name}_64`)

/** 时间字段（subs_edit_box.cpp 的 TimeField：TIME_START / TIME_END / TIME_DURATION）：
 *  连续修改同一字段才合并为一个撤销点（CommitTimes 的 last_time_commit_type 判据） */
type TimeFieldKey = 'startMs' | 'endMs' | 'duration'

/** edit/color/* 按钮 → 覆写标签 + 样式字段（command/edit.cpp show_color_picker） */
const COLOR_TAGS = {
  c: { tag: '\\c', alt: '\\1c', field: 'primaryColor' },
  '2c': { tag: '\\2c', alt: '', field: 'secondaryColor' },
  '3c': { tag: '\\3c', alt: '', field: 'outlineColor' },
  '4c': { tag: '\\4c', alt: '', field: 'backColor' },
} as const
type ColorTagKey = keyof typeof COLOR_TAGS

/** edit/style/* 按钮 → 覆写标签 + 样式字段（command/edit.cpp toggle_override_tag） */
const STYLE_TOGGLES = {
  b: { tag: '\\b', field: 'bold', label: 'toggle bold' },
  i: { tag: '\\i', field: 'italic', label: 'toggle italic' },
  u: { tag: '\\u', field: 'underline', label: 'toggle underline' },
  s: { tag: '\\s', field: 'strikeout', label: 'toggle strikeout' },
} as const
type StyleToggleKey = keyof typeof STYLE_TOGGLES

/** edit/font（command/edit.cpp font_for_line）：光标处的有效字体 */
interface EffectiveFont {
  family: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
}

/** AssStyle 默认值（ass_style.h）：Arial 48、主色白、描边/阴影黑、无修饰 */
const DEFAULT_FONT: EffectiveFont = {
  family: 'Arial',
  size: 48,
  bold: false,
  italic: false,
  underline: false,
}

/** 字符计数（Subtitle/Character Counter：Ignore Whitespace / Ignore Punctuation） */
function longestVisibleLine(text: string, ignoreWhitespace: boolean, ignorePunctuation: boolean) {
  const visibleText = text.replace(/\{[^}]*\}/g, '')
  const lines = visibleText.split(/\\[Nn]|\r?\n/)
  return Math.max(
    0,
    ...lines.map((line) => {
      let value = Array.from(line)
      if (ignorePunctuation) value = value.filter((c) => !/\p{P}/u.test(c))
      if (ignoreWhitespace) value = value.filter((c) => !/[\p{Z}\s]/u.test(c))
      return value.length
    }),
  )
}

function stripPlainText(text: string) {
  return [...text.matchAll(/\{[^}]*\}/g)].map(([block]) => block).join('')
}

/** 编辑框选区变化：写入模块级光标状态并上报核心
 *  （subs_controller.cpp:OnTextSelectionChanged → 修订撤销栈顶条目）；pos 为光标端 */
function reportTextSelection(
  element: HTMLTextAreaElement,
  onTextSelection: (pos: number, start: number, end: number) => void,
) {
  editCursorState.selectionStart = element.selectionStart
  editCursorState.selectionEnd = element.selectionEnd
  const start = element.selectionStart
  const end = element.selectionEnd
  // 反向选区（backward）光标在 start，否则在 end
  onTextSelection(element.selectionDirection === 'backward' ? start : end, start, end)
}

/** 光标当前偏移（反向选区时在 start，否则在 end，同 reportTextSelection 语义） */
function caretOffsetOf(element: HTMLTextAreaElement): number {
  return element.selectionDirection === 'backward' ? element.selectionStart : element.selectionEnd
}

/** 光标偏移是否落在带段级底纹的段内（模板 `!代码!` 块的 #1F1F1F 底纹，见 assHighlight） */
function offsetInBackedSegment(segments: AssHighlightSegment[], offset: number): boolean {
  let pos = 0
  for (const segment of segments) {
    if (offset < pos + segment.text.length) return segment.background !== undefined
    pos += segment.text.length
  }
  // 光标在文本末尾（最后一段的尾边缘）：按最后一段判定
  return segments.length > 0 && segments[segments.length - 1].background !== undefined
}

/** 选区覆盖色（CSS 变量）：与 textarea 的半透明选区叠色后恰为 VS Code 选区色 (39,80,119) */
const SELECTION_BACKED_BACKGROUND = 'var(--editor-selection-backed)'

/**
 * 段级深色底纹（模板 `!代码!` 的 #1F1F1F）被选区覆盖的部分单独渲染：
 * 底纹直接叠半透明选区太浅（约 (33,49,61)），选中处要换成 `--editor-selection-backed`。
 * 只在选区与底纹段相交时把该段按选区边界切成「前 / 选中 / 后」三片——不能整段换色，
 * 否则拖选 2 个字符时整段（往往就是一个单词/整块代码）都会看起来被选中。
 * 无选区相交时原样返回同一数组引用，保证 HighlightBase 的 memo 仍然整段跳渲染。
 */
function splitSegmentsBySelection(
  segments: AssHighlightSegment[],
  selection: { start: number; end: number } | null,
): AssHighlightSegment[] {
  if (!selection) return segments
  let offset = 0
  let changed = false
  const result: AssHighlightSegment[] = []
  for (const segment of segments) {
    const length = segment.text.length
    const from = Math.max(selection.start, offset) - offset
    const to = Math.min(selection.end, offset + length) - offset
    if (segment.background === undefined || to <= from) {
      result.push(segment)
    } else {
      changed = true
      if (from > 0) result.push({ ...segment, text: segment.text.slice(0, from) })
      result.push({
        ...segment,
        text: segment.text.slice(from, to),
        background: SELECTION_BACKED_BACKGROUND,
      })
      if (to < length) result.push({ ...segment, text: segment.text.slice(to) })
    }
    offset += length
  }
  return changed ? result : segments
}

/** 选区是否与段级底纹（模板 `!代码!` 块）相交：相交时返回选区范围，否则 null */
function backedSelectionFor(
  element: HTMLTextAreaElement,
  segments: AssHighlightSegment[],
): { start: number; end: number } | null {
  const start = element.selectionStart
  const end = element.selectionEnd
  if (start === end || document.activeElement !== element) return null
  let offset = 0
  for (const segment of segments) {
    const length = segment.text.length
    if (segment.background !== undefined && offset < end && offset + length > start)
      return { start, end }
    offset += length
  }
  return null
}

/** 高亮异步计算结果：连同输入（文本 + 各开关）一起记录，供渲染期判定是否为当前值 */
interface HighlightResult {
  text: string
  templateLine: boolean
  templateLua: boolean
  syntax: boolean
  segments: AssHighlightSegment[]
}

/** 高亮渲染视图：base 为可整体复用（引用相等 → React.memo 跳渲染）的稳定段，
 *  tail 为追加输入尚未着色的新尾巴（异步结果未就绪的过渡帧） */
interface HighlightView {
  base: AssHighlightSegment[]
  baseLength: number
  tail: string
  /** 尾巴沿用最后一段的类型/底纹：新输入在过渡帧不掉色，结果到达后再按词法修正 */
  tailType: AssSyntaxType
  tailBackground?: string
}

/** 光标是否落在带底纹段内（视图形态）：光标位于 base 末尾且存在尾巴时按尾巴样式判定，
 *  其余按段表判定（同 offsetInBackedSegment 尾边缘语义） */
function caretInBackedSegment(view: HighlightView, offset: number): boolean {
  if (offset > view.baseLength) return false
  if (offset === view.baseLength && view.tail !== '') return view.tailBackground !== undefined
  return offsetInBackedSegment(view.base, offset)
}

/** 取旧段表在指定偏移处的样式（用于变化区过渡上色）；偏移越界时退回末段 */
function styleAt(segments: AssHighlightSegment[], offset: number): AssHighlightSegment | null {
  let pos = 0
  for (const segment of segments) {
    if (offset < pos + segment.text.length) return segment
    pos += segment.text.length
  }
  return segments.length > 0 ? segments[segments.length - 1] : null
}

/** 中间编辑的过渡视图：把旧段表重映射到新文本（公共前缀/后缀段原样保留，仅变化区
 *  沿用插入点处的旧样式）。此前只保留公共前缀、光标后的整片文本回退一帧无样式，
 *  每次按键都闪一下；重映射后 cursor 之后的区域样式连续，视觉与稳态一致 */
function remapSegments(
  oldText: string,
  oldSegments: AssHighlightSegment[],
  text: string,
): AssHighlightSegment[] {
  const max = Math.min(oldText.length, text.length)
  let prefix = 0
  while (prefix < max && oldText[prefix] === text[prefix]) prefix++
  let suffix = 0
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === text[text.length - 1 - suffix]
  )
    suffix++
  const oldSuffixStart = oldText.length - suffix
  const newMiddleEnd = text.length - suffix
  const segments: AssHighlightSegment[] = []

  // 公共前缀：按旧段切片（边界段被切开时才新建对象，其余原样复用）
  let pos = 0
  for (const segment of oldSegments) {
    if (pos >= prefix) break
    const end = Math.min(pos + segment.text.length, prefix)
    if (end > pos) {
      segments.push(
        end - pos === segment.text.length ? segment : { ...segment, text: text.slice(pos, end) },
      )
    }
    pos += segment.text.length
  }
  // 变化区：沿用插入点的旧样式（典型为原地打字/删字，视觉上与周围一致）
  if (prefix < newMiddleEnd) {
    const style = styleAt(oldSegments, prefix)
    segments.push({
      text: text.slice(prefix, newMiddleEnd),
      type: style?.type ?? 'NORMAL',
      ...(style?.background ? { background: style.background } : null),
    })
  }
  // 公共后缀：旧段从 oldSuffixStart 起切片（新文本尾部与旧文本尾部逐字符相同）
  pos = 0
  for (const segment of oldSegments) {
    const segmentStart = pos
    pos += segment.text.length
    if (pos <= oldSuffixStart) continue
    const from = Math.max(segmentStart, oldSuffixStart)
    if (from === segmentStart) segments.push(segment)
    else
      segments.push({
        ...segment,
        text: text.slice(
          newMiddleEnd + (from - oldSuffixStart),
          newMiddleEnd + (pos - oldSuffixStart),
        ),
      })
  }
  return segments
}

/** 过渡视图（异步结果未就绪的帧）：pre 层文本必须始终等于 textarea 文本（两层逐字符
 *  对齐约束），故 base 文本 + tail 必须覆盖当前文本。追加输入（最常见）时旧段表整段
 *  原样复用，数千 span 的重渲染被 React.memo 短路；中间编辑按前缀/变化区/后缀重映射，
 *  只有变化区使用过渡样式 */
function transitionalView(result: HighlightResult | null, text: string): HighlightView {
  if (!result) return { base: [], baseLength: 0, tail: text, tailType: 'NORMAL' }
  if (text.startsWith(result.text)) {
    const last = result.segments[result.segments.length - 1]
    return {
      base: result.segments,
      baseLength: result.text.length,
      tail: text.slice(result.text.length),
      tailType: last?.type ?? 'NORMAL',
      tailBackground: last?.background,
    }
  }
  return {
    base: remapSegments(result.text, result.segments, text),
    baseLength: text.length,
    tail: '',
    tailType: 'NORMAL',
  }
}

/** 高亮计算异步化（同步分词 + 数千 span 渲染会在长模板行上阻塞每次按键）：
 *  以 rAF 合并同帧内的连续输入、每帧至多计算一次；结果未就绪的帧用 transitionalView
 *  复用旧样式过渡。开关/模板行变化同样使旧结果过期（判定含全部输入字段） */
function useAsyncHighlight(
  text: string,
  templateLine: boolean,
  templateLua: boolean,
  syntax: boolean,
): HighlightView {
  const [result, setResult] = useState<HighlightResult | null>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      // 关闭语法高亮时整段 NORMAL（对应源码 SetStyling(line_text.size(), 0)）
      const segments = syntax
        ? tokenizeAss(text, templateLine, templateLua)
        : [{ text, type: 'NORMAL' as const }]
      setResult({ text, templateLine, templateLua, syntax, segments })
    })
    return () => cancelAnimationFrame(frame)
  }, [text, templateLine, templateLua, syntax])
  if (
    result !== null &&
    result.text === text &&
    result.templateLine === templateLine &&
    result.templateLua === templateLua &&
    result.syntax === syntax
  ) {
    return { base: result.segments, baseLength: text.length, tail: '', tailType: 'NORMAL' }
  }
  return transitionalView(result, text)
}

/** span 内联样式缓存：按「类型 × 底纹」预建样式对象并复用引用——React 对 style 浅比较
 *  时引用不变即跳过 DOM 写入；配色表由 getSpanStyleCache 按（主题 × 选项版本）键控复用 */
interface SpanStyleCache {
  colors: Record<AssSyntaxType, AssSyntaxStyle>
  styles: Map<string, CSSProperties>
}

/** 段样式（取代原内联 JSX）：Bold 对齐源码 Colour/Subtitle/Syntax/Bold/* 选项，但用
 *  text-stroke 模拟加粗——fontWeight 会改变字形宽度，导致高亮层与 textarea 纯文本
 *  换行位置/光标位置错位（源码 Scintilla 单控件无此问题） */
function buildSpanStyle(base: AssSyntaxStyle, background: string | undefined): CSSProperties {
  return {
    color: base.color,
    ...(base.bold ? { WebkitTextStroke: '0.45px currentColor' } : null),
    // 绘图端点坐标下划线（Underline/Drawing Endpoint，源码 StyleSetUnderline）
    ...(base.underline ? { textDecoration: 'underline' } : null),
    // 底纹：段级底纹（模板 `!代码!` 块的 Dark Modern 编辑区底色）优先于 Background/* 配置色
    ...(background
      ? {
          backgroundColor: background,
          // 块级底纹向下沉降 2px：背景盒底边与 `_` 等下伸字符擦边看不清，阴影扩展
          // 绘制区留出间距（ink overflow，不产生滚动溢出、不影响两层对齐）
          boxShadow: `0 2px 0 0 ${background}`,
        }
      : base.background
        ? { backgroundColor: base.background }
        : null),
  }
}

function buildSpanStyleCache(colors: Record<AssSyntaxType, AssSyntaxStyle>): SpanStyleCache {
  const styles = new Map<string, CSSProperties>()
  for (const [type, style] of Object.entries(colors) as [AssSyntaxType, AssSyntaxStyle][]) {
    styles.set(type, buildSpanStyle(style, undefined))
    styles.set(`${type}\u0000${LUA_BLOCK_BACKGROUND}`, buildSpanStyle(style, LUA_BLOCK_BACKGROUND))
  }
  return { colors, styles }
}

/** 段 → 缓存样式（未命中则即时构建：非块底纹的不常见底纹颜色走此路径） */
function spanStyleFor(cache: SpanStyleCache, segment: AssHighlightSegment): CSSProperties {
  const key = segment.background ? `${segment.type}\u0000${segment.background}` : segment.type
  return cache.styles.get(key) ?? buildSpanStyle(cache.colors[segment.type], segment.background)
}

/** span 样式表（单槽缓存）：按「主题 × 选项版本」键控复用同一引用——React 对 style 浅比较
 *  时引用不变即跳过 DOM 写入；选项提交后版本号变化，配色表（Colour/Syntax/*）自然重建 */
let styleCacheKey = ''
let styleCacheEntry: SpanStyleCache | null = null

function getSpanStyleCache(dark: boolean, version: number): SpanStyleCache {
  const key = `${dark ? 'dark' : 'light'}\u0000${version}`
  if (!styleCacheEntry || styleCacheKey !== key) {
    styleCacheKey = key
    styleCacheEntry = buildSpanStyleCache(getSyntaxColors(dark))
  }
  return styleCacheEntry
}

/** 稳定段渲染：segments 引用不变时整段跳渲染（追加输入的中间帧只多渲染尾巴一个 span） */
const HighlightBase = memo(function HighlightBase({
  segments,
  cache,
}: {
  segments: AssHighlightSegment[]
  cache: SpanStyleCache
}) {
  return (
    <>
      {segments.map((segment, index) => (
        <span key={index} style={spanStyleFor(cache, segment)}>
          {segment.text}
        </span>
      ))}
    </>
  )
})

/** 静态子树（Comment/Style/Actor/Effect、时间/边距、格式工具栏）拖动期间不重建：
 *  subs_edit_box.cpp OnCommit 对 COMMIT_DIAG_TEXT 只执行 edit_ctrl->SetTextTo +
 *  UpdateCharacterCount，其余控件一律不刷新；这里用 memo 复现该语义。
 *  事件处理器经 handlers ref 转发（每次父渲染在 layout effect 中换成最新闭包，
 *  子组件跳渲染也不会拿到陈旧 draft/cue） */
interface EditRowHandlers {
  /** 合并写草稿（函数式更新：拖动期间不持有渲染期 draft，避免回写陈旧 text） */
  patchDraft: (patch: Partial<SubtitleCue>) => void
  commit: (field: keyof SubtitleCue, value: SubtitleCue[keyof SubtitleCue], label: string) => void
  commitField: (
    field: 'actor' | 'effect' | 'marginL' | 'marginR' | 'marginV',
    value: string | number,
    label: string,
    amend: boolean,
  ) => void
  commitTimes: (patch: { startMs?: number; endMs: number }, field: TimeFieldKey) => void
  commitTimeKeystroke: (field: 'startMs' | 'endMs', value: number) => void
  setTime: (
    field: 'startMs' | 'endMs',
    text: string,
    parser: (value: string) => number | null,
  ) => void
  timeSession: () => { id: string; startMs: number; endMs: number }
  clearTimeSession: () => void
  setEditingField: (field: keyof SubtitleCue | null) => void
  toggleOverrideTag: (key: StyleToggleKey) => void
  openFontPicker: () => void
  openColorPicker: (key: ColorTagKey) => void
  applyColor: (hex: string) => void
  onCommand: (id: string) => void
  onEditStyle: () => void
  onFrameModeChange: (value: boolean) => void
  toggleShowOriginal: (value: boolean) => void
}

/** handlers 在 layout effect 中赋值（首次绘制前必已就绪），故 current 可视为非空 */
interface HandlersRef {
  current: EditRowHandlers
}

function sameList<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((value, index) => value === b[index]))
}

interface EditTopRowProps {
  cueId: string
  comment: boolean
  style: string
  actor: string
  effect: string
  styles: SubtitleStyle[]
  actors: string[]
  effects: string[]
  handlers: HandlersRef
}

const EditTopRow = memo(
  function EditTopRow({
    cueId,
    comment,
    style,
    actor,
    effect,
    styles,
    actors,
    effects,
    handlers,
  }: EditTopRowProps) {
    // subs_edit_box.cpp：style_box->Select(style_box->FindString(line->Style))，
    // FindString 未命中返回 -1 → 只读 combo 显示空（悬空引用，如样式改名时选了"否"）
    const styleExists = styles.some((item) => item.name === style)
    return (
      <>
        <label className="comment-toggle">
          <input
            type="checkbox"
            checked={comment}
            onChange={(event) => {
              const value = event.target.checked
              handlers.current.patchDraft({ comment: value })
              handlers.current.commit('comment', value, 'comment change')
            }}
          />
          {tPlain('Comment')}
        </label>
        <label className="edit-style">
          <select
            value={styleExists ? style : ''}
            onChange={(event) => {
              const value = event.target.value
              handlers.current.patchDraft({ style: value })
              handlers.current.commit('style', value, 'style change')
            }}
          >
            {/* 未命中时补一个空项承载 value=''，避免浏览器回退选中首项 */}
            {!styleExists && <option value="" />}
            {styles.map((item) => (
              <option key={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        {/* 源码 Edit 按钮直接打开当前行样式的编辑对话框（subs_edit_box.cpp，样式缺失时禁用；无 SetToolTip） */}
        <button
          className="edit-edit-btn"
          onClick={() => handlers.current.onEditStyle()}
          disabled={!styleExists}
        >
          {tPlain('Edit')}
        </button>
        <label className="edit-actor">
          <input
            list={`edit-actor-values-${cueId}`}
            placeholder={tPlain('Actor')}
            value={actor}
            onFocus={() => handlers.current.setEditingField('actor')}
            onChange={(event) => {
              const value = event.target.value
              handlers.current.patchDraft({ actor: value })
              // 逐键输入合并为一个撤销点（subs_edit_box.cpp OnActorChange: amend = EVT_TEXT）
              handlers.current.commitField('actor', value, 'actor change', true)
            }}
            onBlur={(event) => {
              handlers.current.setEditingField(null)
              handlers.current.commitField('actor', event.target.value, 'actor change', false)
            }}
          />
          <datalist id={`edit-actor-values-${cueId}`}>
            {actors.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label className="edit-effect">
          <input
            list={`edit-effect-values-${cueId}`}
            placeholder={tPlain('Effect')}
            value={effect}
            onFocus={() => handlers.current.setEditingField('effect')}
            onChange={(event) => {
              const value = event.target.value
              handlers.current.patchDraft({ effect: value })
              handlers.current.commitField('effect', value, 'effect change', true)
            }}
            onBlur={(event) => {
              handlers.current.setEditingField(null)
              handlers.current.commitField('effect', event.target.value, 'effect change', false)
            }}
          />
          <datalist id={`edit-effect-values-${cueId}`}>
            {effects.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
      </>
    )
  },
  (a, b) =>
    a.cueId === b.cueId &&
    a.comment === b.comment &&
    a.style === b.style &&
    a.actor === b.actor &&
    a.effect === b.effect &&
    a.handlers === b.handlers &&
    sameList(a.styles, b.styles) &&
    sameList(a.actors, b.actors) &&
    sameList(a.effects, b.effects),
)

interface EditTimesRowProps {
  layer: number
  startMs: number
  endMs: number
  marginL: number
  marginR: number
  marginV: number
  frameTiming: boolean
  frameRate: Framerate
  handlers: HandlersRef
}

const EditTimesRow = memo(
  function EditTimesRow({
    layer,
    startMs,
    endMs,
    marginL,
    marginR,
    marginV,
    frameTiming,
    frameRate,
    handlers,
  }: EditTimesRowProps) {
    // 帧号模式（timeedit_ctrl SetByFrame）：Start=FrameAtTime(START)，End=FrameAtTime(END)，时长含首帧
    const toStartText = (ms: number) =>
      frameTiming ? String(frameRate.frameAtTime(ms, 'start')) : formatEditorTime(ms)
    const toEndText = (ms: number) =>
      frameTiming ? String(frameRate.frameAtTime(ms, 'end')) : formatEditorTime(ms)
    const parseFrameInput = (text: string, kind: 'start' | 'end'): number | null => {
      const value = Number(text.trim())
      return Number.isInteger(value) && value >= 0 ? frameRate.timeAtFrame(value, kind) : null
    }
    const parseStartInput = (text: string): number | null =>
      frameTiming ? parseFrameInput(text, 'start') : parseEditorTime(text)
    const parseEndInput = (text: string): number | null =>
      frameTiming ? parseFrameInput(text, 'end') : parseEditorTime(text)
    const durationFrames = Math.max(
      1,
      frameRate.frameAtTime(endMs, 'end') - frameRate.frameAtTime(startMs, 'start') + 1,
    )
    return (
      <div className="edit-row edit-row-times">
        <input
          className="layer-field"
          aria-label={tPlain('Layer')}
          title={tPlain('Layer number')}
          type="number"
          min={0}
          max={999}
          value={layer}
          onFocus={() => handlers.current.setEditingField('layer')}
          onChange={(event) => handlers.current.patchDraft({ layer: Number(event.target.value) })}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.commit('layer', Number(event.target.value), 'layer change')
          }}
        />
        <input
          className="time-field"
          aria-label={tPlain('Start')}
          title={tPlain('Start time')}
          value={toStartText(startMs)}
          onFocus={() => handlers.current.setEditingField('startMs')}
          onChange={(event) => {
            const parsed = parseStartInput(event.target.value)
            if (parsed !== null) handlers.current.commitTimeKeystroke('startMs', parsed)
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.setTime('startMs', event.target.value, parseStartInput)
            handlers.current.clearTimeSession()
          }}
        />
        <input
          className="time-field"
          aria-label={tPlain('End')}
          title={tPlain('End time')}
          value={toEndText(endMs)}
          onFocus={() => handlers.current.setEditingField('endMs')}
          onChange={(event) => {
            const parsed = parseEndInput(event.target.value)
            if (parsed !== null) handlers.current.commitTimeKeystroke('endMs', parsed)
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.setTime('endMs', event.target.value, parseEndInput)
            handlers.current.clearTimeSession()
          }}
        />
        <input
          className="time-field duration-field"
          aria-label={tPlain('Duration')}
          title={tPlain('Line duration')}
          value={
            frameTiming ? String(durationFrames) : formatEditorTime(Math.max(0, endMs - startMs))
          }
          onFocus={() => handlers.current.setEditingField('endMs')}
          onChange={(event) => {
            if (frameTiming) {
              const frames = Number(event.target.value.trim())
              if (Number.isInteger(frames) && frames >= 1) {
                const nextEndMs = frameRate.timeAtFrame(
                  frameRate.frameAtTime(startMs, 'start') + frames - 1,
                  'end',
                )
                // CommitTimes TIME_DURATION：End=Start+时长，更新会话初值 End，不钳制 Start
                const session = handlers.current.timeSession()
                session.endMs = nextEndMs
                handlers.current.patchDraft({ endMs: nextEndMs })
                handlers.current.commitTimes({ endMs: nextEndMs }, 'duration')
              }
              return
            }
            const parsed = parseEditorTime(event.target.value)
            if (parsed !== null) {
              const nextEndMs = startMs + parsed
              const session = handlers.current.timeSession()
              session.endMs = nextEndMs
              handlers.current.patchDraft({ endMs: nextEndMs })
              handlers.current.commitTimes({ endMs: nextEndMs }, 'duration')
            }
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            if (frameTiming) return // 帧模式在 onChange 即时提交
            const parsed = parseEditorTime(event.target.value)
            if (parsed !== null) {
              const nextEndMs = startMs + parsed
              handlers.current.patchDraft({ endMs: nextEndMs })
              handlers.current.commitTimes({ endMs: nextEndMs }, 'duration')
            }
            handlers.current.clearTimeSession()
          }}
        />
        <input
          className="margin-field"
          aria-label={tPlain('Left margin')}
          title={tPlain('Left Margin (0 = default from style)')}
          type="number"
          value={marginL}
          onFocus={() => handlers.current.setEditingField('marginL')}
          onChange={(event) => {
            const value = Number(event.target.value)
            handlers.current.patchDraft({ marginL: value })
            handlers.current.commitField('marginL', value, 'left margin change', false)
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.commitField(
              'marginL',
              Number(event.target.value),
              'left margin change',
              false,
            )
          }}
        />
        <input
          className="margin-field"
          aria-label={tPlain('Right margin')}
          title={tPlain('Right Margin (0 = default from style)')}
          type="number"
          value={marginR}
          onFocus={() => handlers.current.setEditingField('marginR')}
          onChange={(event) => {
            const value = Number(event.target.value)
            handlers.current.patchDraft({ marginR: value })
            handlers.current.commitField('marginR', value, 'right margin change', false)
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.commitField(
              'marginR',
              Number(event.target.value),
              'right margin change',
              false,
            )
          }}
        />
        <input
          className="margin-field"
          aria-label={tPlain('Vertical margin')}
          title={tPlain('Vertical Margin (0 = default from style)')}
          type="number"
          value={marginV}
          onFocus={() => handlers.current.setEditingField('marginV')}
          onChange={(event) => {
            const value = Number(event.target.value)
            handlers.current.patchDraft({ marginV: value })
            handlers.current.commitField('marginV', value, 'vertical margin change', false)
          }}
          onBlur={(event) => {
            handlers.current.setEditingField(null)
            handlers.current.commitField(
              'marginV',
              Number(event.target.value),
              'vertical margin change',
              false,
            )
          }}
        />
      </div>
    )
  },
  (a, b) =>
    a.layer === b.layer &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.marginL === b.marginL &&
    a.marginR === b.marginR &&
    a.marginV === b.marginV &&
    a.frameTiming === b.frameTiming &&
    a.frameRate === b.frameRate &&
    a.handlers === b.handlers,
)

interface EditFormatRowProps {
  frameTiming: boolean
  frameRateLoaded: boolean
  showOriginal: boolean
  colorPickerRef: { current: HTMLInputElement | null }
  handlers: HandlersRef
}

const EditFormatRow = memo(function EditFormatRow({
  frameTiming,
  frameRateLoaded,
  showOriginal,
  colorPickerRef,
  handlers,
}: EditFormatRowProps) {
  return (
    <div className="edit-row edit-row-format" aria-label={tPlain('Text formatting tools')}>
      <button
        onClick={() => handlers.current.toggleOverrideTag('b')}
        title={commandTooltip('edit/style/bold', 'Subtitle Edit Box')}
        aria-label={tPlain('Bold')}
      >
        <img src={EDIT_ICON('button_bold')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.toggleOverrideTag('i')}
        title={commandTooltip('edit/style/italic', 'Subtitle Edit Box')}
        aria-label={tPlain('Italics')}
      >
        <img src={EDIT_ICON('button_italics')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.toggleOverrideTag('u')}
        title={commandTooltip('edit/style/underline', 'Subtitle Edit Box')}
        aria-label={tPlain('Underline')}
      >
        <img src={EDIT_ICON('button_underline')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.toggleOverrideTag('s')}
        title={commandTooltip('edit/style/strikeout', 'Subtitle Edit Box')}
        aria-label={tPlain('Strikeout')}
      >
        <img src={EDIT_ICON('button_strikeout')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.openFontPicker()}
        title={commandTooltip('edit/font', 'Subtitle Edit Box')}
        aria-label={tPlain('Font Face')}
      >
        <img src={EDIT_ICON('button_fontname')} alt="" width={16} height={16} draggable={false} />
      </button>
      <span className="edit-toolbar-spacer" />
      <button
        onClick={() => handlers.current.openColorPicker('c')}
        title={commandTooltip('edit/color/primary', 'Subtitle Edit Box')}
        aria-label={tPlain('Primary Color')}
      >
        <img src={EDIT_ICON('button_color_one')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.openColorPicker('2c')}
        title={commandTooltip('edit/color/secondary', 'Subtitle Edit Box')}
        aria-label={tPlain('Secondary Color')}
      >
        <img src={EDIT_ICON('button_color_two')} alt="" width={16} height={16} draggable={false} />
      </button>
      <button
        onClick={() => handlers.current.openColorPicker('3c')}
        title={commandTooltip('edit/color/outline', 'Subtitle Edit Box')}
        aria-label={tPlain('Outline Color')}
      >
        <img
          src={EDIT_ICON('button_color_three')}
          alt=""
          width={16}
          height={16}
          draggable={false}
        />
      </button>
      <button
        onClick={() => handlers.current.openColorPicker('4c')}
        title={commandTooltip('edit/color/shadow', 'Subtitle Edit Box')}
        aria-label={tPlain('Shadow Color')}
      >
        <img src={EDIT_ICON('button_color_four')} alt="" width={16} height={16} draggable={false} />
      </button>
      <input
        ref={colorPickerRef}
        type="color"
        defaultValue="#ffffff"
        onChange={(event) => handlers.current.applyColor(event.target.value)}
        aria-hidden="true"
        tabIndex={-1}
        className="edit-color-picker"
      />
      <span className="edit-toolbar-spacer" />
      <button
        onClick={() => handlers.current.onCommand('grid/line/next/create')}
        title={commandTooltip('grid/line/next/create', 'Subtitle Edit Box')}
        aria-label={tPlain('Next line')}
      >
        <img
          src={EDIT_ICON('button_audio_commit')}
          alt=""
          width={16}
          height={16}
          draggable={false}
        />
      </button>
      <span className="edit-time-mode" role="radiogroup" aria-label={tPlain('Time display mode')}>
        <label>
          <input
            type="radio"
            name="edit-time-mode"
            checked={!frameTiming}
            onChange={() => handlers.current.onFrameModeChange(false)}
          />{' '}
          {tPlain('Time')}
        </label>
        <label>
          <input
            type="radio"
            name="edit-time-mode"
            disabled={!frameRateLoaded}
            checked={frameTiming}
            onChange={() => handlers.current.onFrameModeChange(true)}
          />{' '}
          {tPlain('Frame')}
        </label>
      </span>
      <label className="show-original">
        <input
          type="checkbox"
          checked={showOriginal}
          onChange={(event) => handlers.current.toggleShowOriginal(event.target.checked)}
        />{' '}
        {tPlain('Show Original')}
      </label>
    </div>
  )
})

interface EditPanelProps {
  cue: SubtitleCue | null
  styles: SubtitleStyle[]
  /** 全文档去重排序的 Actor/Effect 值（subs_edit_box.cpp PopulateList） */
  actors: string[]
  effects: string[]
  frameRate: Framerate
  /** 帧号显示模式（timecodes 加载后可用；timeedit_ctrl SetByFrame） */
  frameMode: boolean
  onFrameModeChange: (value: boolean) => void
  /** amend = 修订上一次提交（subs_edit_box.cpp:Commit 的 commitId 回传；由 EditPanel 按
   *  "同描述 / 同时间字段" 判定后下发） */
  onCommit: (patch: Partial<Omit<SubtitleCue, 'id'>>, label: string, amend?: boolean) => void
  onCommand: (id: string) => void
  isCommandEnabled: (id: string) => boolean
  /** Edit 按钮：直接打开当前行样式的编辑对话框（源码 DialogStyleEditor） */
  onEditStyle: () => void
  /** 文本选区实时上报核心（subs_controller.cpp:OnTextSelectionChanged；修订撤销栈顶条目） */
  onTextSelection: (pos: number, start: number, end: number) => void
  /** 核心撤销栈顶条目的文本选区快照（UndoInfo pos/sel_start/sel_end） */
  textSelection: { pos: number; start: number; end: number }
  /** 撤销/重做跳转计数：变化时强制回写编辑框文本并按快照恢复选区/光标 */
  historyNonce: number
}

export function EditPanel({
  cue,
  styles,
  actors,
  effects,
  frameRate,
  frameMode,
  onFrameModeChange,
  onCommit,
  onCommand,
  isCommandEnabled,
  onEditStyle,
  onTextSelection,
  textSelection,
  historyNonce,
}: EditPanelProps) {
  const [draft, setDraft] = useState<SubtitleCue | null>(cue ? structuredClone(cue) : null)
  // Show Original 持久化（subs_edit_box.cpp OnSplit 写 OPT_SET "Subtitle/Show Original"）
  const [showOriginal, setShowOriginal] = useState(() => getOptionBool('Subtitle/Show Original'))
  const [originalText, setOriginalText] = useState(cue?.text ?? '')
  const originalCueIdRef = useRef(cue?.id)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const colorPickerRef = useRef<HTMLInputElement>(null)
  const colorTagRef = useRef<ColorTagKey>('c')
  // 颜色写入位置（openColorPicker 时捕获，用户在系统取色器停留期间编辑器可能失焦）
  const colorPosRef = useRef<{ selStart: number; normStart: number }>({ selStart: 0, normStart: 0 })
  // edit/font 字体选择弹窗（wxGetFontFromUser）
  const [fontDraft, setFontDraft] = useState<EffectiveFont | null>(null)
  const [fontFamilies, setFontFamilies] = useState<string[]>([])
  // 时间框编辑会话起点（subs_edit_box.cpp initial_times：焦点获得时快照，
  // 改 Start 时 End=max(Start, 会话初值)、改 End 时 Start=min(End, 会话初值)）
  const initialTimesRef = useRef<{ id: string; startMs: number; endMs: number } | null>(null)
  // 焦点字段用 state：渲染期草稿重置需要读取（React Compiler 禁止渲染期访问 ref），
  // 且换行时在渲染期重置（React 官方"props 变化调整 state"模式）
  const [editingField, setEditingField] = useState<keyof SubtitleCue | null>(null)
  // 已发送字段值：按 "行id:字段" 键控（cue prop 可能落后于在途事务，用陈旧 cue 比较
  // 会漏发补丁；跨行残留的键值只会命中"core 已有该值"的正确 no-op）
  const sentFieldsRef = useRef<
    Record<string, string | number | boolean | { startMs?: number; endMs: number }>
  >({})
  // 右键菜单（subs_edit_ctrl.cpp OnContextMenu）
  const [textMenu, setTextMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!textMenu) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.grid-context-menu')) setTextMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [textMenu])
  // cue 变化时重置草稿（React 官方"props 变化调整 state"模式：渲染期更新）
  const [prevCue, setPrevCue] = useState<SubtitleCue | null>(cue)
  // 撤销/重做跳转：此时以核心文本全量回写草稿（对齐 subs_edit_box.cpp UpdateFields 的
  // edit_ctrl->SetTextTo(line->Text) 路径），焦点字段守卫不得吞掉跳转后的文本
  const [prevHistoryNonce, setPrevHistoryNonce] = useState(historyNonce)
  const historyJump = historyNonce !== prevHistoryNonce
  if (historyJump) setPrevHistoryNonce(historyNonce)
  if (cue !== prevCue) {
    setPrevCue(cue)
    if (cue?.id !== prevCue?.id) {
      // 换行即结束编辑会话（源码 OnCommit → initial_times.clear()）；时间会话 ref 由
      // commitTimeKeystroke 按 cue.id 键控自动重建，blur 时清空
      setEditingField(null)
    }
    setDraft((old) => {
      if (!cue) return null
      if (!old || cue.id !== old.id) return structuredClone(cue)
      // apply 回写晚于下一次按键时，回写中间值会在渲染期覆盖本地草稿吞掉输入：
      // 焦点字段以本地草稿为准（同行内）；撤销/重做跳转例外（源码始终 SetTextTo）
      if (!editingField || historyJump) return structuredClone(cue)
      const merged = structuredClone(cue)
      ;(merged as unknown as Record<string, unknown>)[editingField] = (
        old as unknown as Record<string, unknown>
      )[editingField]
      return merged
    })
  }
  const darkTheme = useSystemTheme() === 'dark'
  useEffect(() => {
    if (cue?.id !== originalCueIdRef.current) {
      originalCueIdRef.current = cue?.id
      setOriginalText(cue?.text ?? '')
    }
  }, [cue])
  // 高亮渲染视图（异步计算，hook 必须在「无选中行」提前 return 之前调用）。
  // 模板行判据 subs_edit_ctrl.cpp UpdateStyle：仅「Comment 且 Effect 以 template
  // 开头」的行启用卡拉OK模板词法（源码 boost::istarts_with(Effect, "template")）
  const {
    base: highlightBase,
    baseLength: highlightBaseLength,
    tail: highlightTail,
    tailType: highlightTailType,
    tailBackground: highlightTailBackground,
  } = useAsyncHighlight(
    draft?.text ?? '',
    !!(draft && draft.comment && draft.effect.toLowerCase().startsWith('template')),
    getOptionBool('Subtitle/Highlight/Template Lua'),
    getOptionBool('Subtitle/Highlight/Syntax'),
  )
  const [backedSelection, setBackedSelection] = useState<{ start: number; end: number } | null>(
    null,
  )
  const highlightBaseRef = useRef(highlightBase)
  useEffect(() => {
    // 原生 selectionchange 监听只挂一次，段表经 ref 读取最新值（effect 内更新以满足 refs 规则）
    highlightBaseRef.current = highlightBase
  }, [highlightBase])
  // 渲染期把与选区相交的底纹段切成「前 / 选中 / 后」三片（未相交时原样返回同一引用）
  const displayBase = splitSegmentsBySelection(highlightBase, backedSelection)
  // 渲染期视图对象（caret 判定与尾巴 span 共用；每帧新建、不做 memo）
  const highlightView = {
    base: highlightBase,
    baseLength: highlightBaseLength,
    tail: highlightTail,
    tailType: highlightTailType,
    tailBackground: highlightTailBackground,
  }
  // span 样式表（按主题×选项版本复用引用，见 getSpanStyleCache）：React 对 style 浅比较
  // 时引用不变即跳过，稳定段在重渲染中不产生样式开销
  const optionsVersion = useOptionsVersion()
  const spanStyleCache = getSpanStyleCache(darkTheme, optionsVersion)
  // 高亮异步到达（或过渡/开关变化）时同步光标色：光标未动时 textarea 的 ref 回调
  // 不保证重跑，只有工具函数 trackCursor 的路径会漏掉「仅高亮变化」的重渲染
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const next = caretInBackedSegment(
      {
        base: highlightBase,
        baseLength: highlightBaseLength,
        tail: highlightTail,
        tailType: highlightTailType,
        tailBackground: highlightTailBackground,
      },
      caretOffsetOf(editor),
    )
      ? LUA_BLOCK_CARET
      : ''
    editor.style.caretColor = next
    // 段表重建后相交判定可能变化：重新计算底纹段要按选区切分的范围
    setBackedSelection(backedSelectionFor(editor, highlightBase))
  }, [
    highlightBase,
    highlightBaseLength,
    highlightTail,
    highlightTailType,
    highlightTailBackground,
  ])
  // 按住鼠标拖选时只有原生 selectionchange，React 的 onSelect 要等 mouseup 才触发：
  // 若只在 onSelect 里换色，拖拽过程中底纹段仍是 #1F1F1F（选区很浅），松手才变深蓝
  useEffect(() => {
    const onSelectionChange = () => {
      const editor = editorRef.current
      if (!editor) return
      setBackedSelection(backedSelectionFor(editor, highlightBaseRef.current))
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])
  // 静态子树处理器转发：每次渲染后在 layout effect（首帧绘制前）替换为最新闭包，
  // 子组件 memo 跳渲染时事件回调仍读到最新 draft/cue（latest-ref 模式：effect 回调
  // 在渲染完成后才执行，不存在初始化期访问；无依赖表是刻意的——每次渲染都要刷新）
  /* oxlint-disable react/immutability, react-hooks/exhaustive-deps */
  const handlersRef = useRef<EditRowHandlers>(null as unknown as EditRowHandlers)
  useLayoutEffect(() => {
    if (!cue || !draft) return
    handlersRef.current = {
      patchDraft,
      commit,
      commitField,
      commitTimes,
      commitTimeKeystroke,
      setTime,
      timeSession,
      clearTimeSession: () => {
        initialTimesRef.current = null
      },
      setEditingField,
      toggleOverrideTag,
      openFontPicker,
      openColorPicker,
      applyColor,
      onCommand,
      onEditStyle,
      onFrameModeChange,
      toggleShowOriginal: (value: boolean) => {
        setShowOriginal(value)
        setOption('Subtitle/Show Original', value)
      },
    }
  })
  /* oxlint-enable react/immutability, react-hooks/exhaustive-deps */
  // 撤销/重做后恢复编辑框文本选区与光标（subs_controller.cpp:Apply → SetInsertionPoint(pos)
  // + SetSelection(sel_start, sel_end)）；以 DOM 实际文本长度钳制，光标端决定选区方向
  const historyNonceRef = useRef(historyNonce)
  useLayoutEffect(() => {
    if (historyNonceRef.current === historyNonce) return
    historyNonceRef.current = historyNonce
    const editor = editorRef.current
    if (!editor) return
    const clamp = (value: number) => Math.max(0, Math.min(value, editor.value.length))
    const start = clamp(textSelection.start)
    const end = clamp(textSelection.end)
    const pos = clamp(textSelection.pos)
    editor.setSelectionRange(start, end, pos === start && start !== end ? 'backward' : 'forward')
    reportTextSelection(editor, onTextSelection)
  }, [historyNonce, textSelection, onTextSelection])
  /** 编辑框的提交合并槽（subs_edit_box.cpp 的 commit_id + last_commit_type / last_time_commit_type）：
   *  只有描述未变（时间修改按字段细分）才回传上次提交（amend），否则开新撤销点；行 id 参与 key
   *  以复现 OnActiveLineChanged 切行重置 commit_id 的行为 */
  const amendKeyRef = useRef('')
  if (!cue || !draft)
    return <section className="edit-panel empty-edit">{tPlain('No line selected')}</section>

  const commitAmend = (key: string, requested: boolean) => {
    const amend = requested && key === amendKeyRef.current
    amendKeyRef.current = key
    return amend
  }
  const commit = (
    field: keyof SubtitleCue,
    value: SubtitleCue[keyof SubtitleCue],
    label: string,
  ) => {
    // 源码 OnCommentChange/OnStyleChange/OnLayerEnter 不传 amend（每次各自成点）
    if (cue[field] !== value)
      onCommit({ [field]: value }, label, commitAmend(`${cue.id}:${label}`, false))
  }
  /** 合并写草稿（函数式更新：memo 静态子树的处理器经 ref 调用，不持有渲染期 draft） */
  const patchDraft = (patch: Partial<SubtitleCue>) => {
    setDraft((old) => (old ? { ...old, ...patch } : old))
  }
  /** 逐键提交（源码 EVT_TEXT）：以已发送值为准去重（cue prop 可能落后于在途事务，
   *  用陈旧 cue 比较会漏发补丁）；键含行 id，跨行残留只会命中"core 已有该值"的 no-op */
  const commitField = (
    field: 'actor' | 'effect' | 'marginL' | 'marginR' | 'marginV',
    value: string | number,
    label: string,
    amend: boolean,
  ) => {
    const key = `${cue.id}:${field}`
    if (sentFieldsRef.current[key] === value) return
    sentFieldsRef.current[key] = value
    // Actor/Effect 逐键（wxEVT_TEXT）才 amend，失焦不 amend；边距不 amend（源码同上）
    onCommit(
      { [field]: value } as Partial<Omit<SubtitleCue, 'id'>>,
      label,
      commitAmend(`${cue.id}:${label}`, amend),
    )
  }
  /** 时间提交（subs_edit_box.cpp CommitTimes）：以已发送值为准去重后发送；
   *  undo 标签 "modify times"（源码同）；连续修改同一字段才 amend（last_time_commit_type） */
  const commitTimes = (patch: { startMs?: number; endMs: number }, field: TimeFieldKey) => {
    const key = `${cue.id}:times`
    const sent = sentFieldsRef.current[key] as { startMs?: number; endMs: number } | undefined
    const startSent = patch.startMs === undefined || sent?.startMs === patch.startMs
    if (startSent && sent?.endMs === patch.endMs) return
    sentFieldsRef.current[key] = { ...sent, ...patch }
    onCommit(patch, 'modify times', commitAmend(`${cue.id}:times:${field}`, true))
  }
  /** 时间编辑会话（subs_edit_box.cpp initial_times）：按行缓存快照，跨行自动重建 */
  const timeSession = () => {
    let session = initialTimesRef.current
    if (!session || session.id !== cue.id) {
      session = { id: cue.id, startMs: cue.startMs, endMs: cue.endMs }
      initialTimesRef.current = session
    }
    return session
  }
  /** Start/End 输入逐键提交（CommitTimes TIME_START/TIME_END 分支）：改 Start 时
   *  End=max(Start, 会话初值)；改 End 时 Start=min(End, 会话初值) */
  const commitTimeKeystroke = (field: 'startMs' | 'endMs', value: number) => {
    const session = timeSession()
    let patch: { startMs: number; endMs: number }
    if (field === 'startMs') {
      session.startMs = value
      patch = { startMs: value, endMs: Math.max(value, session.endMs) }
    } else {
      session.endMs = value
      patch = { endMs: value, startMs: Math.min(value, session.startMs) }
    }
    setDraft((old) => (old ? { ...old, ...patch } : old))
    commitTimes(patch, field)
  }
  /** 光标处的有效字体（command/edit.cpp font_for_line） */
  const effectiveFontAt = (text: string, normPos: number): EffectiveFont => {
    const style = styles.find((s) => s.name === draft.style)
    const blocks = parseBlocks(text)
    const blockn = blockAtPos(text, normPos)
    const read = (tag: string) => findTag(blocks, blockn, tag)
    const boldTag = read('\\b')
    const italicTag = read('\\i')
    const underlineTag = read('\\u')
    const sizeTag = read('\\fs')
    const familyTag = read('\\fn')
    const size = sizeTag ? Number.parseInt(sizeTag.params, 10) : Number.NaN
    return {
      family: familyTag?.params || style?.fontName || DEFAULT_FONT.family,
      size: Number.isFinite(size) ? size : (style?.fontSize ?? DEFAULT_FONT.size),
      bold: boldTag
        ? tagBool(boldTag.params, style?.bold ?? DEFAULT_FONT.bold)
        : (style?.bold ?? DEFAULT_FONT.bold),
      italic: italicTag
        ? tagBool(italicTag.params, style?.italic ?? DEFAULT_FONT.italic)
        : (style?.italic ?? DEFAULT_FONT.italic),
      underline: underlineTag
        ? tagBool(underlineTag.params, style?.underline ?? DEFAULT_FONT.underline)
        : (style?.underline ?? DEFAULT_FONT.underline),
    }
  }

  const setTime = (
    field: 'startMs' | 'endMs',
    text: string,
    parser: (value: string) => number | null = parseEditorTime,
  ) => {
    const value = parser(text)
    if (value === null) {
      setDraft(cue ? structuredClone(cue) : null)
      return
    }
    // subs_edit_box.cpp CommitTimes：改 Start 时 End=max(Start, 会话初值)；
    // 改 End 时 Start=min(End, 会话初值)；未进入编辑会话按当前值互钳
    const initial = initialTimesRef.current ?? { startMs: cue.startMs, endMs: cue.endMs }
    const patch: { startMs?: number; endMs: number } =
      field === 'startMs'
        ? { startMs: value, endMs: Math.max(value, initial.endMs) }
        : { endMs: value, startMs: Math.min(value, initial.startMs) }
    setDraft((old) => (old ? { ...old, ...patch } : old))
    commitTimes(patch, field)
  }
  /** command/edit.cpp toggle_override_tag：光标处读取当前状态后真实切换；
   *  有选区时首尾各写一个标签（state?0:1 … state?1:0），无选区只写光标处一个 */
  const toggleOverrideTag = (key: StyleToggleKey) => {
    const editor = editorRef.current
    if (!editor) return
    const { tag, field, label } = STYLE_TOGGLES[key]
    const selStart = editor.selectionStart
    const selEnd = editor.selectionEnd
    const normStart = normalizePos(draft.text, selStart)
    const normEnd = normalizePos(draft.text, selEnd)
    // 初始状态：样式值，再被光标前最近的同名标签覆盖（get_value）
    const style = styles.find((s) => s.name === draft.style)
    let state: boolean =
      field === 'bold'
        ? (style?.bold ?? false)
        : field === 'italic'
          ? (style?.italic ?? false)
          : field === 'underline'
            ? (style?.underline ?? false)
            : (style?.strikeout ?? false)
    const found = findTag(parseBlocks(draft.text), blockAtPos(draft.text, normStart), tag)
    if (found) state = tagBool(found.params, state)
    const first = setTag(draft.text, tag, state ? '0' : '1', normStart, selStart)
    let nextText = first.text
    if (selStart !== selEnd) {
      nextText = setTag(nextText, tag, state ? '1' : '0', normEnd, selEnd + first.shift).text
    }
    commitText(nextText, label)
    // update_lines：选区随插入量平移
    requestAnimationFrame(() =>
      editor.setSelectionRange(selStart + first.shift, selEnd + first.shift),
    )
  }
  const syncScroll = () => {
    if (highlightRef.current && editorRef.current) {
      highlightRef.current.scrollTop = editorRef.current.scrollTop
      highlightRef.current.scrollLeft = editorRef.current.scrollLeft
    }
  }
  const commitText = (text: string, label: string) => {
    setDraft((old) => (old ? { ...old, text } : old))
    // subs_edit_box.cpp:CommitText 传 amend=true → 同描述的连续文本提交合并
    onCommit({ text }, label, commitAmend(`${cue.id}:${label}`, true))
    requestAnimationFrame(() => editorRef.current?.focus())
  }
  // edit/color/*（command/edit.cpp show_color_picker）：初始色 = 样式色被光标处
  // 同名标签覆盖；写入走 set_tag（替换光标块内同名标签）。浏览器原生取色器无
  // alpha，源码的 \1a 回写路径不触发
  const openColorPicker = (key: ColorTagKey) => {
    colorTagRef.current = key
    const { tag, alt, field } = COLOR_TAGS[key]
    const style = styles.find((s) => s.name === draft.style)
    // 样式色（&HAABBGGRR）→ #RRGGBB；无样式时主色白、其余黑（AssStyle 默认值）
    const initial = style ? assColorToHex(style[field]) : key === 'c' ? '#ffffff' : '#000000'
    let shown = initial
    const editor = editorRef.current
    if (editor) {
      const selStart = editor.selectionStart
      const normStart = normalizePos(draft.text, selStart)
      const found = findTag(parseBlocks(draft.text), blockAtPos(draft.text, normStart), tag, alt)
      shown = (found && tagColorHex(found.params)) || initial
      colorPosRef.current = { selStart, normStart }
    }
    if (colorPickerRef.current) {
      colorPickerRef.current.value = shown
      colorPickerRef.current.click()
    }
  }
  const applyColor = (hex: string) => {
    const { tag } = COLOR_TAGS[colorTagRef.current]
    const { selStart, normStart } = colorPosRef.current
    const result = setTag(draft.text, tag, assOverrideColor(hex), normStart, selStart)
    commitText(result.text, 'set color')
    // 源码：选区收拢到写入点之后
    requestAnimationFrame(() =>
      editorRef.current?.setSelectionRange(selStart + result.shift, selStart + result.shift),
    )
  }
  // edit/font（command/edit.cpp）：与光标处有效字体逐项比较，仅写有差异的标签
  const openFontPicker = () => {
    const editor = editorRef.current
    const selStart = editor ? editor.selectionStart : draft.text.length
    const font = effectiveFontAt(draft.text, normalizePos(draft.text, selStart))
    setFontDraft({ ...font })
    void listFontFaces()
      .then((faces) => {
        const imported = faces.flatMap((face) => face.families)
        setFontFamilies((current) => {
          const merged = new Set([...current, ...imported, ...styles.map((s) => s.fontName)])
          return [...merged].sort((a, b) => a.localeCompare(b))
        })
      })
      .catch(() => undefined)
  }
  const applyFont = () => {
    const chosen = fontDraft
    if (!chosen) return
    setFontDraft(null)
    const editor = editorRef.current
    const selStart = editor ? editor.selectionStart : draft.text.length
    const selEnd = editor ? editor.selectionEnd : selStart
    const normStart = normalizePos(draft.text, selStart)
    const start = effectiveFontAt(draft.text, normStart)
    if (
      chosen.family === start.family &&
      chosen.size === start.size &&
      chosen.bold === start.bold &&
      chosen.italic === start.italic &&
      chosen.underline === start.underline
    ) {
      return
    }
    let text = draft.text
    let shift = 0
    const doSet = (tag: string, value: string) => {
      const result = setTag(text, tag, value, normStart, selStart + shift)
      text = result.text
      shift += result.shift
    }
    if (chosen.family !== start.family) doSet('\\fn', chosen.family)
    if (chosen.size !== start.size) doSet('\\fs', String(chosen.size))
    if (chosen.bold !== start.bold) doSet('\\b', chosen.bold ? '1' : '0')
    if (chosen.italic !== start.italic) doSet('\\i', chosen.italic ? '1' : '0')
    // 源码笔误照抄（command/edit.cpp L530-532）：下划线差异同样写 \i
    if (chosen.underline !== start.underline) doSet('\\i', chosen.underline ? '1' : '0')
    commitText(text, 'set font')
    requestAnimationFrame(() => editor?.setSelectionRange(selStart + shift, selEnd + shift))
  }
  // 字符计数（Subtitle/Character Limit 选项；超限红底，UpdateCharacterCount 只显示数字）
  const characterCount = longestVisibleLine(
    draft.text,
    getOptionBool('Subtitle/Character Counter/Ignore Whitespace'),
    getOptionBool('Subtitle/Character Counter/Ignore Punctuation'),
  )
  const characterLimit = getOptionInt('Subtitle/Character Limit')
  const editFontFace = getOptionString('Subtitle/Edit Box/Font Face')
  const editFontSize = Math.round((getOptionInt('Subtitle/Edit Box/Font Size') * 4) / 3)
  const editorStyle = {
    fontSize: `${editFontSize}px`,
    fontFamily: editFontFace ? `"${editFontFace}", sans-serif` : undefined,
  }
  // 模板 `!代码!` 块的 #1F1F1F 底纹内光标用 VS Code 深色光标色（浅色主题下 CSS 的
  // --text 深色 caret 在深色底纹上不可见）；直接写 DOM style，光标纯移动不触发重渲染。
  // 同值重复写入无副作用（CSSOM 对相同值提前返回），不做变化判断、保持最简；
  // Firefox 下光标静置 5-6 秒后停闪为 Windows 插入符超时的浏览器级行为（注册表
  // CaretTimeout 默认 5000ms，Gecko 折算约 5 个闪烁周期后 StopBlinking；
  // about:config 新建 ui.caretBlinkCount = 1000000 可关闭计数），与本写入无关。
  // 光标纯移动走 trackCursor；重渲染路径（改文本/切换行/撤销跳转恢复光标）的兜底同步挂在
  // textarea 的内联回调 ref 上（每次提交都会重调）——不用 useEffect：本组件在「无选中行」
  // 时提前 return，晚于早返回的 hook 会使 hook 数量随状态变化，违反 hooks 规则
  const applyCaretColor = (element: HTMLTextAreaElement) => {
    const next = caretInBackedSegment(highlightView, caretOffsetOf(element)) ? LUA_BLOCK_CARET : ''
    element.style.caretColor = next
  }
  // 帧号模式（timeedit_ctrl SetByFrame）：Start=FrameAtTime(START)，End=FrameAtTime(END)，时长含首帧
  const frameTiming = frameMode && frameRate.isLoaded()
  const frameRateLoaded = frameRate.isLoaded()
  const trackCursor = (element: HTMLTextAreaElement) => {
    reportTextSelection(element, onTextSelection)
    applyCaretColor(element)
  }
  const pasteIntoEditor = async () => {
    const editor = editorRef.current
    if (!editor) return
    try {
      // subs_edit_ctrl Paste：换行统一替换为 \N
      const clipboard = await navigator.clipboard?.readText()
      if (!clipboard) return
      const text = clipboard.replace(/\r\n|\n|\r/g, '\\N')
      const start = editor.selectionStart
      const end = editor.selectionEnd
      const nextText = `${draft.text.slice(0, start)}${text}${draft.text.slice(end)}`
      commitText(nextText, 'modify text')
      requestAnimationFrame(() =>
        editor.setSelectionRange(start + text.length, start + text.length),
      )
    } catch {
      // 剪贴板读取被拒绝时静默忽略
    }
  }
  const runTextMenuCommand = (action: string) => {
    setTextMenu(null)
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    if (action === 'cut' || action === 'copy') {
      document.execCommand(action)
    } else if (action === 'paste') {
      void pasteIntoEditor()
    } else if (action === 'selectall') {
      editor.select()
      trackCursor(editor)
    } else {
      onCommand(action)
    }
  }

  return (
    <section
      className="edit-panel"
      aria-label={tPlain('Line editor')}
      // 整个编辑框是 "Subtitle Edit Box" 热键上下文（源码 wx 传播：TimeEdit 等子
      // 控件的按键沿父链到达 SubsEditBox::OnKeyDown），时间输入框聚焦时热键不失效
      data-shortcut-context="Subtitle Edit Box"
    >
      {/* 第 1 行：Comment | Style | Edit | Actor | Effect | 字符数（Aegisub top_sizer） */}
      <div className="edit-row edit-row-top">
        <EditTopRow
          cueId={cue.id}
          comment={draft.comment}
          style={draft.style}
          actor={draft.actor}
          effect={draft.effect}
          styles={styles}
          actors={actors}
          effects={effects}
          handlers={handlersRef}
        />
        <output
          className={`char-count${characterLimit > 0 && characterCount > characterLimit ? ' over-limit' : ''}`}
          title={tPlain('Number of characters in the longest line of this subtitle')}
        >
          {characterCount}
        </output>
      </div>

      {/* Aegisub middle_left_sizer；足够宽时会把 middle_right_sizer 接到本行末尾。 */}
      <div className="edit-middle">
        <EditTimesRow
          layer={draft.layer}
          startMs={draft.startMs}
          endMs={draft.endMs}
          marginL={draft.marginL}
          marginR={draft.marginR}
          marginV={draft.marginV}
          frameTiming={frameTiming}
          frameRate={frameRate}
          handlers={handlersRef}
        />

        <EditFormatRow
          frameTiming={frameTiming}
          frameRateLoaded={frameRateLoaded}
          showOriginal={showOriginal}
          colorPickerRef={colorPickerRef}
          handlers={handlersRef}
        />
      </div>

      {showOriginal && (
        <textarea
          className="cue-editor-original"
          readOnly
          value={originalText}
          aria-label={tPlain('Original text')}
        />
      )}
      <div className="cue-editor-wrap">
        <pre
          ref={highlightRef}
          className="cue-editor-highlight"
          aria-hidden="true"
          style={editorStyle}
        >
          {/* 稳定段（引用不变时整段跳渲染）+ 尾巴段（异步过渡帧的新输入，沿用末段样式
              以免新字符掉色；结果到达后由词法修正） */}
          <HighlightBase segments={displayBase} cache={spanStyleCache} />
          {highlightTail ? (
            <span
              style={spanStyleFor(spanStyleCache, {
                text: highlightTail,
                type: highlightTailType,
                background: highlightTailBackground,
              })}
            >
              {highlightTail}
            </span>
          ) : null}
          {/* textarea 保留尾随换行的空行盒而 pre 会丢弃末个换行：补一个 \n 保持
              两层行数一致，否则行数不同步时滚动错位、光标与可见文字错位 */}
          {draft.text.endsWith('\n') ? '\n' : null}
        </pre>
        <textarea
          ref={(element) => {
            editorRef.current = element
            // 重渲染路径兜底同步光标色（见 applyCaretColor）；内联回调 ref 每次提交都会重调
            if (element) applyCaretColor(element)
          }}
          className="cue-editor"
          data-shortcut-context="Subtitle Edit Box"
          aria-label={tPlain('Subtitle text')}
          value={draft.text}
          spellCheck={false}
          style={editorStyle}
          onFocus={() => setEditingField('text')}
          onBlur={(event) => {
            if (editingField === 'text') setEditingField(null)
            // 失焦后浏览器不再画选区，底纹段的选中色要还原
            setBackedSelection(backedSelectionFor(event.currentTarget, highlightBase))
          }}
          onSelect={(event) => trackCursor(event.currentTarget)}
          onChange={(event) => {
            setDraft({ ...draft, text: event.target.value })
            trackCursor(event.currentTarget)
            onCommit(
              { text: event.target.value },
              'modify text',
              commitAmend(`${cue.id}:modify text`, true),
            )
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            trackCursor(event.currentTarget)
            setTextMenu({ x: event.clientX, y: event.clientY })
          }}
          onScroll={syncScroll}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              event.shiftKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey
            ) {
              event.preventDefault()
              event.stopPropagation()
              const editor = event.currentTarget
              // Subtitle/Edit Box/Soft Line Break：Shift+Enter 插入 \n 或 \N（subs_edit_ctrl.cpp）
              const tag = getOptionBool('Subtitle/Edit Box/Soft Line Break') ? '\\n' : '\\N'
              const nextText = `${draft.text.slice(0, editor.selectionStart)}${tag}${draft.text.slice(editor.selectionEnd)}`
              const nextPosition = editor.selectionStart + 2
              setDraft({ ...draft, text: nextText })
              onCommit(
                { text: nextText },
                'modify text',
                commitAmend(`${cue.id}:modify text`, true),
              )
              requestAnimationFrame(() => editor.setSelectionRange(nextPosition, nextPosition))
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault()
              event.stopPropagation()
              onCommit(
                { text: draft.text },
                'modify text',
                commitAmend(`${cue.id}:modify text`, true),
              )
              onCommand('grid/line/next/create')
            } else if (event.key === 'Tab') {
              event.preventDefault()
              const focusable = Array.from(
                document.querySelectorAll<HTMLElement>(
                  'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
                ),
              ).filter(
                (element) => !element.hasAttribute('disabled') && element.offsetParent !== null,
              )
              const index = focusable.indexOf(event.currentTarget)
              const nextIndex = Math.max(
                0,
                Math.min(focusable.length - 1, index + (event.shiftKey ? -1 : 1)),
              )
              focusable[nextIndex]?.focus()
            }
          }}
        />
      </div>
      {showOriginal && (
        <div className="edit-bottom-actions">
          <button onClick={() => commitText(originalText, 'revert line')}>
            {tPlain('Revert')}
          </button>
          <button onClick={() => commitText('', 'clear line')}>{tPlain('Clear')}</button>
          <button onClick={() => commitText(stripPlainText(draft.text), 'clear line')}>
            {tPlain('Clear Text')}
          </button>
          <button
            onClick={() => {
              const editor = editorRef.current
              const start = editor?.selectionStart ?? draft.text.length
              const end = editor?.selectionEnd ?? start
              commitText(
                `${draft.text.slice(0, start)}${originalText}${draft.text.slice(end)}`,
                'insert original',
              )
            }}
          >
            {tPlain('Insert Original')}
          </button>
        </div>
      )}

      {fontDraft && (
        <Dialog
          title={tPlain('Font Face')}
          onClose={() => setFontDraft(null)}
          footer={
            <>
              <button onClick={applyFont}>{tPlain('OK')}</button>
              <button onClick={() => setFontDraft(null)}>{tPlain('Cancel')}</button>
            </>
          }
        >
          <div className="dialog-fields">
            <label>
              {tPlain('Font face')}
              <input
                list="edit-font-families"
                value={fontDraft.family}
                onChange={(event) => setFontDraft({ ...fontDraft, family: event.target.value })}
                autoFocus
              />
              <datalist id="edit-font-families">
                {fontFamilies.map((family) => (
                  <option key={family} value={family} />
                ))}
              </datalist>
            </label>
            <label>
              {tPlain('Font size')}
              <input
                type="number"
                min={1}
                max={2000}
                value={fontDraft.size}
                onChange={(event) =>
                  setFontDraft({ ...fontDraft, size: Number(event.target.value) })
                }
              />
            </label>
            <label className="comment-toggle">
              <input
                type="checkbox"
                checked={fontDraft.bold}
                onChange={(event) => setFontDraft({ ...fontDraft, bold: event.target.checked })}
              />
              {tPlain('Bold')}
            </label>
            <label className="comment-toggle">
              <input
                type="checkbox"
                checked={fontDraft.italic}
                onChange={(event) => setFontDraft({ ...fontDraft, italic: event.target.checked })}
              />
              {tPlain('Italics')}
            </label>
            <label className="comment-toggle">
              <input
                type="checkbox"
                checked={fontDraft.underline}
                onChange={(event) =>
                  setFontDraft({ ...fontDraft, underline: event.target.checked })
                }
              />
              {tPlain('Underline')}
            </label>
          </div>
        </Dialog>
      )}

      {textMenu && (
        <MenuPopup x={textMenu.x} y={textMenu.y} label={tPlain('Text editor menu')}>
          <button className="menu-item" role="menuitem" onClick={() => runTextMenuCommand('cut')}>
            <span className="menu-label">{tPlain('Cut')}</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => runTextMenuCommand('copy')}>
            <span className="menu-label">{tPlain('Copy')}</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => runTextMenuCommand('paste')}>
            <span className="menu-label">{tPlain('Paste')}</span>
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => runTextMenuCommand('selectall')}
          >
            <span className="menu-label">{tPlain('Select All')}</span>
          </button>
          <div className="menu-separator" role="separator" />
          <button
            className="menu-item"
            role="menuitem"
            disabled={!isCommandEnabled('edit/line/split/preserve')}
            onClick={() => runTextMenuCommand('edit/line/split/preserve')}
          >
            {/* 源码菜单用完整 STR_MENU 标签（subs_edit_ctrl.cpp OnContextMenu） */}
            <span className="menu-label">{tPlain(COMMANDS['edit/line/split/preserve'].label)}</span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!isCommandEnabled('edit/line/split/estimate')}
            onClick={() => runTextMenuCommand('edit/line/split/estimate')}
          >
            <span className="menu-label">{tPlain(COMMANDS['edit/line/split/estimate'].label)}</span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!isCommandEnabled('edit/line/split/video')}
            onClick={() => runTextMenuCommand('edit/line/split/video')}
          >
            <span className="menu-label">{tPlain(COMMANDS['edit/line/split/video'].label)}</span>
          </button>
        </MenuPopup>
      )}
    </section>
  )
}
