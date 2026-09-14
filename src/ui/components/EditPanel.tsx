import { useEffect, useRef, useState } from 'react'

import { getOptionBool, getOptionInt, getOptionString } from '../../config/options'
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
import { tokenizeAss, getSyntaxColors } from '../assHighlight'
import { assColorToHex } from '../color'
import { editCursorState } from '../commandRegistry'
import { commandTooltip } from '../commands'
import { tPlain } from '../i18n'
import { useSystemTheme } from '../theme'
import { Dialog } from './dialogs'
import { MenuPopup } from './MenuPopup'

const EDIT_ICON = (name: string) => aegisubIconUrl(name, 16)

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
  onCommit: (patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void
  onCommand: (id: string) => void
  isCommandEnabled: (id: string) => boolean
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
}: EditPanelProps) {
  const [draft, setDraft] = useState<SubtitleCue | null>(cue ? structuredClone(cue) : null)
  const [showOriginal, setShowOriginal] = useState(false)
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
  const initialTimesRef = useRef<{ startMs: number; endMs: number } | null>(null)
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
  if (cue !== prevCue) {
    setPrevCue(cue)
    setDraft(cue ? structuredClone(cue) : null)
  }
  const darkTheme = useSystemTheme() === 'dark'
  useEffect(() => {
    if (cue?.id !== originalCueIdRef.current) {
      originalCueIdRef.current = cue?.id
      setOriginalText(cue?.text ?? '')
    }
  }, [cue])
  if (!cue || !draft)
    return <section className="edit-panel empty-edit">{tPlain('No line selected')}</section>

  const commit = (
    field: keyof SubtitleCue,
    value: SubtitleCue[keyof SubtitleCue],
    label: string,
  ) => {
    if (cue[field] !== value) onCommit({ [field]: value }, label)
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
    const patch: Partial<Omit<SubtitleCue, 'id'>> =
      field === 'startMs'
        ? { startMs: value, endMs: Math.max(value, initial.endMs) }
        : { endMs: value, startMs: Math.min(value, initial.startMs) }
    setDraft({ ...draft, ...patch })
    onCommit(patch, 'modify times')
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
    setDraft({ ...draft, text })
    onCommit({ text }, label)
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
  const highlighted = tokenizeAss(draft.text)
  const syntaxColors = getSyntaxColors(darkTheme)
  const syntaxHighlight = getOptionBool('Subtitle/Highlight/Syntax')
  // 字符计数（Subtitle/Character Limit + Counter 选项；超限红色，CPS 超 warning/error 阈值提示）
  const characterCount = longestVisibleLine(
    draft.text,
    getOptionBool('Subtitle/Character Counter/Ignore Whitespace'),
    getOptionBool('Subtitle/Character Counter/Ignore Punctuation'),
  )
  const characterLimit = getOptionInt('Subtitle/Character Limit')
  const cpsWarningThreshold = getOptionInt('Subtitle/Character Counter/CPS Warning Threshold')
  const cpsErrorThreshold = getOptionInt('Subtitle/Character Counter/CPS Error Threshold')
  const lineCps =
    draft.endMs > draft.startMs
      ? Math.round(
          (draft.text.replace(/\{[^}]*\}/g, '').length * 1000) / (draft.endMs - draft.startMs),
        )
      : 0
  const editFontFace = getOptionString('Subtitle/Edit Box/Font Face')
  const editFontSize = Math.round((getOptionInt('Subtitle/Edit Box/Font Size') * 4) / 3)
  const editorStyle = {
    fontSize: `${editFontSize}px`,
    fontFamily: editFontFace ? `"${editFontFace}", sans-serif` : undefined,
  }
  // 帧号模式（timeedit_ctrl SetByFrame）：Start=FrameAtTime(START)，End=FrameAtTime(END)，时长含首帧
  const frameTiming = frameMode && frameRate.isLoaded()
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
    frameRate.frameAtTime(draft.endMs, 'end') - frameRate.frameAtTime(draft.startMs, 'start') + 1,
  )
  const trackCursor = (element: HTMLTextAreaElement) => {
    editCursorState.selectionStart = element.selectionStart
    editCursorState.selectionEnd = element.selectionEnd
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
      commitText(nextText, 'Edit text')
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
    <section className="edit-panel" aria-label={tPlain('Line editor')}>
      {/* 第 1 行：Comment | Style | Edit | Actor | Effect | 字符数（Aegisub top_sizer） */}
      <div className="edit-row edit-row-top">
        <label className="comment-toggle">
          <input
            type="checkbox"
            checked={draft.comment}
            onChange={(event) => {
              setDraft({ ...draft, comment: event.target.checked })
              commit('comment', event.target.checked, 'Toggle comment')
            }}
          />
          {tPlain('Comment')}
        </label>
        <label className="edit-style">
          <select
            value={draft.style}
            onChange={(event) => {
              setDraft({ ...draft, style: event.target.value })
              commit('style', event.target.value, 'Set style')
            }}
          >
            {styles.map((style) => (
              <option key={style.id}>{style.name}</option>
            ))}
          </select>
        </label>
        <button
          className="edit-edit-btn"
          onClick={() => onCommand('tool/style/manager')}
          title={tPlain('Edit style')}
        >
          {tPlain('Edit')}
        </button>
        <label className="edit-actor">
          <input
            list={`edit-actor-values-${cue.id}`}
            placeholder={tPlain('Actor')}
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            onBlur={() => commit('actor', draft.actor, 'Set actor')}
          />
          <datalist id={`edit-actor-values-${cue.id}`}>
            {actors.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label className="edit-effect">
          <input
            list={`edit-effect-values-${cue.id}`}
            placeholder={tPlain('Effect')}
            value={draft.effect}
            onChange={(event) => setDraft({ ...draft, effect: event.target.value })}
            onBlur={() => commit('effect', draft.effect, 'Set effect')}
          />
          <datalist id={`edit-effect-values-${cue.id}`}>
            {effects.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <output
          className={`char-count${characterLimit > 0 && characterCount > characterLimit ? ' over-limit' : ''}`}
          title={tPlain('Number of characters in the longest line of this subtitle')}
        >
          {characterCount}
          {characterLimit > 0 ? `/${characterLimit}` : ''}
          {lineCps > 0 && lineCps > cpsWarningThreshold ? (
            <span className={`char-cps${lineCps > cpsErrorThreshold ? ' cps-error' : ' cps-warn'}`}>
              {' '}
              {lineCps} {tPlain('cps')}
            </span>
          ) : null}
        </output>
      </div>

      {/* Aegisub middle_left_sizer；足够宽时会把 middle_right_sizer 接到本行末尾。 */}
      <div className="edit-middle">
        <div className="edit-row edit-row-times">
          <input
            className="layer-field"
            aria-label={tPlain('Layer')}
            title={tPlain('Layer number')}
            type="number"
            min={0}
            max={999}
            value={draft.layer}
            onChange={(event) => setDraft({ ...draft, layer: Number(event.target.value) })}
            onBlur={() => commit('layer', draft.layer, 'Set layer')}
          />
          <input
            className="time-field"
            aria-label={tPlain('Start')}
            title={tPlain('Start time')}
            value={toStartText(draft.startMs)}
            onChange={(event) => {
              const parsed = parseStartInput(event.target.value)
              if (parsed !== null) setDraft({ ...draft, startMs: parsed })
            }}
            onBlur={(event) => setTime('startMs', event.target.value, parseStartInput)}
          />
          <input
            className="time-field"
            aria-label={tPlain('End')}
            title={tPlain('End time')}
            value={toEndText(draft.endMs)}
            onChange={(event) => {
              const parsed = parseEndInput(event.target.value)
              if (parsed !== null) setDraft({ ...draft, endMs: parsed })
            }}
            onBlur={(event) => setTime('endMs', event.target.value, parseEndInput)}
          />
          <input
            className="time-field duration-field"
            aria-label={tPlain('Duration')}
            title={tPlain('Line duration')}
            value={
              frameTiming
                ? String(durationFrames)
                : formatEditorTime(Math.max(0, draft.endMs - draft.startMs))
            }
            onChange={(event) => {
              if (frameTiming) {
                const frames = Number(event.target.value.trim())
                if (Number.isInteger(frames) && frames >= 1) {
                  const endMs = frameRate.timeAtFrame(
                    frameRate.frameAtTime(draft.startMs, 'start') + frames - 1,
                    'end',
                  )
                  setDraft({ ...draft, endMs })
                  commit('endMs', endMs, 'Set duration')
                }
                return
              }
              const parsed = parseEditorTime(event.target.value)
              if (parsed !== null) {
                const endMs = draft.startMs + parsed
                setDraft({ ...draft, endMs })
                commit('endMs', endMs, 'Set duration')
              }
            }}
            onBlur={(event) => {
              if (frameTiming) return // 帧模式在 onChange 即时提交
              const parsed = parseEditorTime(event.target.value)
              if (parsed !== null) {
                const endMs = draft.startMs + parsed
                setDraft({ ...draft, endMs })
                commit('endMs', endMs, 'Set duration')
              }
            }}
          />
          <input
            className="margin-field"
            aria-label={tPlain('Left margin')}
            title={tPlain('Left Margin (0 = default from style)')}
            type="number"
            value={draft.marginL}
            onChange={(event) => setDraft({ ...draft, marginL: Number(event.target.value) })}
            onBlur={() => commit('marginL', draft.marginL, 'Set left margin')}
          />
          <input
            className="margin-field"
            aria-label={tPlain('Right margin')}
            title={tPlain('Right Margin (0 = default from style)')}
            type="number"
            value={draft.marginR}
            onChange={(event) => setDraft({ ...draft, marginR: Number(event.target.value) })}
            onBlur={() => commit('marginR', draft.marginR, 'Set right margin')}
          />
          <input
            className="margin-field"
            aria-label={tPlain('Vertical margin')}
            title={tPlain('Vertical Margin (0 = default from style)')}
            type="number"
            value={draft.marginV}
            onChange={(event) => setDraft({ ...draft, marginV: Number(event.target.value) })}
            onBlur={() => commit('marginV', draft.marginV, 'Set vertical margin')}
          />
        </div>

        <div className="edit-row edit-row-format" aria-label={tPlain('Text formatting tools')}>
          <button
            onClick={() => toggleOverrideTag('b')}
            title={commandTooltip('edit/style/bold', 'Subtitle Edit Box')}
            aria-label={tPlain('Bold')}
          >
            <img src={EDIT_ICON('button_bold')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button
            onClick={() => toggleOverrideTag('i')}
            title={commandTooltip('edit/style/italic', 'Subtitle Edit Box')}
            aria-label={tPlain('Italics')}
          >
            <img
              src={EDIT_ICON('button_italics')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <button
            onClick={() => toggleOverrideTag('u')}
            title={commandTooltip('edit/style/underline', 'Subtitle Edit Box')}
            aria-label={tPlain('Underline')}
          >
            <img
              src={EDIT_ICON('button_underline')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <button
            onClick={() => toggleOverrideTag('s')}
            title={commandTooltip('edit/style/strikeout', 'Subtitle Edit Box')}
            aria-label={tPlain('Strikeout')}
          >
            <img
              src={EDIT_ICON('button_strikeout')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <button
            onClick={openFontPicker}
            title={commandTooltip('edit/font', 'Subtitle Edit Box')}
            aria-label={tPlain('Font Face')}
          >
            <img
              src={EDIT_ICON('button_fontname')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <span className="edit-toolbar-spacer" />
          <button
            onClick={() => openColorPicker('c')}
            title={commandTooltip('edit/color/primary', 'Subtitle Edit Box')}
            aria-label={tPlain('Primary Color')}
          >
            <img
              src={EDIT_ICON('button_color_one')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <button
            onClick={() => openColorPicker('2c')}
            title={commandTooltip('edit/color/secondary', 'Subtitle Edit Box')}
            aria-label={tPlain('Secondary Color')}
          >
            <img
              src={EDIT_ICON('button_color_two')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <button
            onClick={() => openColorPicker('3c')}
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
            onClick={() => openColorPicker('4c')}
            title={commandTooltip('edit/color/shadow', 'Subtitle Edit Box')}
            aria-label={tPlain('Shadow Color')}
          >
            <img
              src={EDIT_ICON('button_color_four')}
              alt=""
              width={16}
              height={16}
              draggable={false}
            />
          </button>
          <input
            ref={colorPickerRef}
            type="color"
            defaultValue="#ffffff"
            onChange={(event) => applyColor(event.target.value)}
            aria-hidden="true"
            tabIndex={-1}
            className="edit-color-picker"
          />
          <span className="edit-toolbar-spacer" />
          <button
            onClick={() => onCommand('grid/line/next/create')}
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
          <span
            className="edit-time-mode"
            role="radiogroup"
            aria-label={tPlain('Time display mode')}
          >
            <label>
              <input
                type="radio"
                name="edit-time-mode"
                checked={!frameTiming}
                onChange={() => onFrameModeChange(false)}
              />{' '}
              {tPlain('Time')}
            </label>
            <label>
              <input
                type="radio"
                name="edit-time-mode"
                disabled={!frameRate.isLoaded()}
                checked={frameTiming}
                onChange={() => onFrameModeChange(true)}
              />{' '}
              {tPlain('Frame')}
            </label>
          </span>
          <label className="show-original">
            <input
              type="checkbox"
              checked={showOriginal}
              onChange={(event) => setShowOriginal(event.target.checked)}
            />{' '}
            {tPlain('Show Original')}
          </label>
        </div>
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
          {(syntaxHighlight
            ? highlighted
            : highlighted.filter((segment) => segment.type === 'NORMAL')
          ).map((segment, index) => {
            const style = syntaxColors[segment.type]
            return (
              <span key={index} style={{ color: style.color, fontWeight: style.bold ? 700 : 400 }}>
                {segment.text}
              </span>
            )
          })}
        </pre>
        <textarea
          ref={editorRef}
          className="cue-editor"
          data-shortcut-context="Subtitle Edit Box"
          aria-label={tPlain('Subtitle text')}
          value={draft.text}
          spellCheck
          style={editorStyle}
          onSelect={(event) => trackCursor(event.currentTarget)}
          onChange={(event) => {
            setDraft({ ...draft, text: event.target.value })
            trackCursor(event.currentTarget)
            onCommit({ text: event.target.value }, 'Edit text')
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
              onCommit({ text: nextText }, 'Edit text')
              requestAnimationFrame(() => editor.setSelectionRange(nextPosition, nextPosition))
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault()
              event.stopPropagation()
              onCommit({ text: draft.text }, 'Edit text')
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
          <button onClick={() => commitText(originalText, 'Revert line')}>
            {tPlain('Revert')}
          </button>
          <button onClick={() => commitText('', 'Clear line')}>{tPlain('Clear')}</button>
          <button onClick={() => commitText(stripPlainText(draft.text), 'Clear line text')}>
            {tPlain('Clear Text')}
          </button>
          <button
            onClick={() => {
              const editor = editorRef.current
              const start = editor?.selectionStart ?? draft.text.length
              const end = editor?.selectionEnd ?? start
              commitText(
                `${draft.text.slice(0, start)}${originalText}${draft.text.slice(end)}`,
                'Insert original',
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
            <span className="menu-label">
              {commandTooltip('edit/line/split/preserve', 'Default').split(' (')[0]}
            </span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!isCommandEnabled('edit/line/split/estimate')}
            onClick={() => runTextMenuCommand('edit/line/split/estimate')}
          >
            <span className="menu-label">
              {commandTooltip('edit/line/split/estimate', 'Default').split(' (')[0]}
            </span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!isCommandEnabled('edit/line/split/video')}
            onClick={() => runTextMenuCommand('edit/line/split/video')}
          >
            <span className="menu-label">
              {commandTooltip('edit/line/split/video', 'Default').split(' (')[0]}
            </span>
          </button>
        </MenuPopup>
      )}
    </section>
  )
}
