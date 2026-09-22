import { useEffect, useRef, useState } from 'react'

import { getOptionString, setOption } from '../../config/options'
import type { SubtitleStyle } from '../../core/types'
import { listFontFaces } from '../../storage/fontStore'
import { assColorToCss, assColorToHex, cssColorToHex, hexToAssColor, hexToCssColor } from '../color'
import { tPlain } from '../i18n'
import { useEscapeClose } from './dialogs'

/**
 * Style Editor 对话框（dialog_style_editor.cpp 的 DialogStyleEditor）。
 *
 * 两个入口共用同一实现（源码 subs_edit_box.cpp 的 Edit 按钮与
 * dialog_style_manager.cpp 都构造 DialogStyleEditor）：
 * - OK     = Apply(true, true)   应用并关闭
 * - Apply  = Apply(true, false)  应用不关闭
 * - Cancel = Apply(false, true)  不应用直接关闭（预览文本照常写回）
 * - 重名   = wxMessageBox("There is already a style with this name...", OK|ICON_ERROR) 后中止
 * - 改名   = 当前脚本的非新建样式且脚本内存在引用时询问 YES/NO/CANCEL
 */

/** ass_style.cpp AssStyle::GetEncodings（Encoding 字段值 + 下拉文案） */
const ENCODINGS: Array<[number, string]> = [
  [-1, 'Auto-detect base direction (libass only)'],
  [0, 'ANSI'],
  [1, 'Default'],
  [2, 'Symbol'],
  [77, 'Mac'],
  [128, 'Shift_JIS'],
  [129, 'Hangeul'],
  [130, 'Johab'],
  [134, 'GB2312'],
  [136, 'Chinese BIG5'],
  [161, 'Greek'],
  [162, 'Turkish'],
  [163, 'Vietnamese'],
  [177, 'Hebrew'],
  [178, 'Arabic'],
  [186, 'Baltic'],
  [204, 'Russian'],
  [222, 'Thai'],
  [238, 'East European'],
  [255, 'OEM'],
]

/** ControlToBorderStyle / BorderStyleToControl（值 1/3/4） */
const BORDER_STYLES: Array<[number, string]> = [
  [1, 'Outline'],
  [3, 'Border boxes'],
  [4, 'Shadow box (libass only)'],
]

/** alignValues：wxRadioBox 3 列，按钮值即 Alignment（ControlToAlign） */
const ALIGNMENTS = [7, 8, 9, 4, 5, 6, 1, 2, 3]

type ColorKey = 'primaryColor' | 'secondaryColor' | 'outlineColor' | 'backColor'

const COLORS: Array<[ColorKey, string, string]> = [
  ['primaryColor', 'Primary', 'Choose primary color'],
  ['secondaryColor', 'Secondary', 'Choose secondary color'],
  ['outlineColor', 'Outline', 'Choose outline color'],
  ['backColor', 'Shadow', 'Choose shadow color'],
]

const MARGINS: Array<['marginL' | 'marginR' | 'marginV', string, string]> = [
  ['marginL', 'Left', 'Distance from left edge, in pixels'],
  ['marginR', 'Right', 'Distance from right edge, in pixels'],
  ['marginV', 'Vert', 'Distance from top/bottom edge, in pixels'],
]

const FONT_STYLES: Array<['bold' | 'italic' | 'underline' | 'strikeout', string]> = [
  ['bold', 'Bold'],
  ['italic', 'Italic'],
  ['underline', 'Underline'],
  ['strikeout', 'Strikeout'],
]

type MessageBoxAnswer = 'ok' | 'yes' | 'no' | 'cancel'

export interface StyleEditorDialogProps {
  /** 源码 style 参数（新建时作模板；name 为改名判断的基准值） */
  style: SubtitleStyle
  /** 重名比对集合（源码 store->GetNames() / c->ass->GetStyles()） */
  existing: SubtitleStyle[]
  /** 源码 is_new：新建样式（首次应用前不做改名询问） */
  isNew?: boolean
  /** 源码 store != nullptr：编辑样式库而非当前脚本 */
  storage?: boolean
  /** 源码 existing != style 的指针身份（比对时排除自身） */
  originalId?: string
  /** 源码 StyleRenamer::NeedsReplace：脚本内是否存在该样式引用 */
  hasReferences?: (name: string) => boolean
  /** 源码 Apply(true, …)：rename 非空表示同时改写脚本内引用（StyleRenamer::Replace） */
  onApply: (style: SubtitleStyle, rename: { from: string; to: string } | null) => void
  /** 源码 Apply(…, true)：关闭对话框 */
  onClose: () => void
  /** 嵌套在样式管理器内 */
  nested?: boolean
}

export function StyleEditorDialog({
  style,
  existing,
  isNew,
  storage,
  originalId,
  hasReferences,
  onApply,
  onClose,
  nested,
}: StyleEditorDialogProps) {
  // ESC 关闭（嵌套消息框后挂载，先于本窗响应）
  useEscapeClose(onClose)
  const [draft, setDraft] = useState(() => structuredClone(style))
  /** 源码 work->name：已应用的样式名（改名判断基准） */
  const appliedNameRef = useRef(style.name)
  const [newStyle, setNewStyle] = useState(!!isNew)
  // 预览文本：OPT_GET 取初值、析构 OPT_SET 写回（Tool/Style Editor/Preview Text）
  const [previewText, setPreviewText] = useState(() =>
    getOptionString('Tool/Style Editor/Preview Text'),
  )
  const previewTextRef = useRef(previewText)
  useEffect(() => {
    previewTextRef.current = previewText
  })
  useEffect(
    () => () => {
      setOption('Tool/Style Editor/Preview Text', previewTextRef.current)
    },
    [],
  )
  // 预览背景色（Colour/Style Editor/Background/Preview，改动即写回）
  const [previewBg, setPreviewBg] = useState(() =>
    getOptionString('Colour/Style Editor/Background/Preview'),
  )
  // 字体列表（源码 font_list：GetFontList 收集到的字体 + 样式自带字体名）
  const [fontFamilies, setFontFamilies] = useState<string[]>(() => [style.fontName])
  useEffect(() => {
    let cancelled = false
    void listFontFaces()
      .then((faces) => {
        if (cancelled) return
        setFontFamilies((current) => [
          ...new Set([...current, ...faces.flatMap((face) => face.families)]),
        ])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  /** 重名消息框（源码 wxMessageBox OK|ICON_ERROR） */
  const [conflict, setConflict] = useState(false)
  /** 改名询问（源码 wxMessageBox YES_NO|CANCEL；close 需带过询问，Yes/No 后仍按本次调用收尾） */
  const [renamePrompt, setRenamePrompt] = useState<{
    from: string
    to: string
    close: boolean
  } | null>(null)

  const patch = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const commit = (name: string, rename: { from: string; to: string } | null) => {
    appliedNameRef.current = name
    setNewStyle(false)
    onApply({ ...draft, name }, rename)
  }

  /** dialog_style_editor.cpp DialogStyleEditor::Apply */
  const apply = (doApply: boolean, close: boolean) => {
    if (doApply) {
      const newName = draft.name
      // 重名检查：GetStyle 大小写不敏感，且 existing != style 排除自身
      const taken = existing.some(
        (item) => item.id !== originalId && item.name.toLowerCase() === newName.toLowerCase(),
      )
      if (taken) {
        setConflict(true)
        return
      }
      const oldName = appliedNameRef.current
      // 改名询问仅限当前脚本的非新建样式（源码 !store && !is_new）
      if (oldName !== newName && !storage && !newStyle && hasReferences?.(oldName)) {
        setRenamePrompt({ from: oldName, to: newName, close })
        return
      }
      commit(newName, null)
    }
    if (close) onClose()
  }

  const answerRename = (answer: 'yes' | 'no' | 'cancel') => {
    const prompt = renamePrompt
    if (!prompt) return
    setRenamePrompt(null)
    // 源码 wxCANCEL：中止本次应用且不关闭对话框
    if (answer === 'cancel') return
    commit(prompt.to, answer === 'yes' ? { from: prompt.from, to: prompt.to } : null)
    // 源码 Apply 尾部统一收尾：Yes/No 都继续执行到 if (close) EndModal
    if (prompt.close) onClose()
  }

  /** add_with_label：标签 + 控件（Outline/Miscellaneous 各行） */
  const numberField = (
    key: 'outline' | 'shadow' | 'scaleX' | 'scaleY' | 'angle' | 'spacing',
    label: string,
    tip: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label title={tPlain(tip)}>
      {tPlain(label)}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        onChange={(event) => patch(key, Number(event.target.value))}
      />
    </label>
  )

  return (
    <div className={`dialog-backdrop${nested ? ' nested' : ''}`}>
      <section
        className="app-dialog style-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tPlain('Style Editor')}
      >
        <header>
          <strong>{tPlain('Style Editor')}</strong>
        </header>
        <div className="style-editor-grid">
          {/* 左列：Style Name / Font / Colors / Margins + Alignment（源码 LeftSizer） */}
          <div className="style-editor-column">
            <fieldset>
              <legend>{tPlain('Style Name')}</legend>
              <input
                title={tPlain('Style name')}
                aria-label={tPlain('Style name')}
                value={draft.name}
                onChange={(event) => patch('name', event.target.value)}
              />
            </fieldset>
            <fieldset>
              <legend>{tPlain('Font')}</legend>
              <div className="style-font-row">
                <input
                  list="style-editor-font-families"
                  title={tPlain('Font face')}
                  aria-label={tPlain('Font face')}
                  value={draft.fontName}
                  onChange={(event) => patch('fontName', event.target.value)}
                />
                <input
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  title={tPlain('Font size')}
                  aria-label={tPlain('Font size')}
                  value={draft.fontSize}
                  onChange={(event) => patch('fontSize', Number(event.target.value))}
                />
              </div>
              <datalist id="style-editor-font-families">
                {fontFamilies.map((family) => (
                  <option key={family} value={family} />
                ))}
              </datalist>
              <div className="style-checks">
                {FONT_STYLES.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(event) => patch(key, event.target.checked)}
                    />
                    {tPlain(label)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>{tPlain('Colors')}</legend>
              <div className="style-colors">
                {COLORS.map(([key, label, tip]) => (
                  <label key={key} className="style-color-field" title={tPlain(tip)}>
                    {tPlain(label)}
                    <span style={{ background: assColorToCss(draft[key]) }} />
                    <input
                      type="color"
                      value={assColorToHex(draft[key])}
                      onChange={(event) =>
                        patch(key, hexToAssColor(event.target.value, draft[key]))
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="style-margin-align">
              <fieldset>
                <legend>{tPlain('Margins')}</legend>
                <div className="style-margins">
                  {MARGINS.map(([key, label, tip]) => (
                    <label key={key} title={tPlain(tip)}>
                      {tPlain(label)}
                      <input
                        type="number"
                        min={-9999}
                        max={99999}
                        value={draft[key]}
                        onChange={(event) => patch(key, Number(event.target.value))}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>{tPlain('Alignment')}</legend>
                <div
                  className="alignment-grid"
                  title={tPlain('Alignment in screen, in numpad style')}
                >
                  {ALIGNMENTS.map((value) => (
                    <button
                      key={value}
                      className={draft.alignment === value ? 'pressed' : ''}
                      onClick={() => patch('alignment', value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
          {/* 右列：Outline / Miscellaneous / Preview（源码 RightSizer） */}
          <div className="style-editor-column">
            <fieldset>
              <legend>{tPlain('Outline')}</legend>
              {numberField('outline', 'Outline:', 'Outline width, in pixels', 0, 1000, 0.1)}
              {numberField('shadow', 'Shadow:', 'Shadow distance, in pixels', 0, 1000, 0.1)}
              <label
                title={tPlain('Whether to draw a normal outline or opaque boxes around the text')}
              >
                {tPlain('Border style:')}
                <select
                  value={draft.borderStyle}
                  onChange={(event) => patch('borderStyle', Number(event.target.value))}
                >
                  {BORDER_STYLES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {tPlain(label)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <fieldset>
              <legend>{tPlain('Miscellaneous')}</legend>
              {numberField('scaleX', 'Scale X%:', 'Scale X, in percentage', 0, 10000, 1)}
              {numberField('scaleY', 'Scale Y%:', 'Scale Y, in percentage', 0, 10000, 1)}
              {numberField(
                'angle',
                'Rotation:',
                'Angle to rotate in Z axis, in degrees',
                -360,
                360,
                1,
              )}
              {numberField('spacing', 'Spacing:', 'Character spacing, in pixels', 0, 1000, 0.1)}
              <label
                title={tPlain(
                  "Encoding, only useful in unicode if the font doesn't have the proper unicode mapping",
                )}
              >
                {tPlain('Encoding:')}
                <select
                  value={draft.encoding}
                  onChange={(event) => patch('encoding', Number(event.target.value))}
                >
                  {ENCODINGS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {`${value} - ${tPlain(label)}`}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <fieldset className="style-preview">
              <legend>{tPlain('Preview')}</legend>
              <div
                className="style-preview-box"
                title={tPlain('Preview of current style')}
                style={{ background: previewBg }}
              >
                <span
                  style={{
                    fontFamily: draft.fontName,
                    fontSize: Math.min(48, draft.fontSize),
                    fontWeight: draft.bold ? 'bold' : 'normal',
                    fontStyle: draft.italic ? 'italic' : 'normal',
                    textDecoration:
                      `${draft.underline ? 'underline ' : ''}${draft.strikeout ? 'line-through' : ''}`.trim() ||
                      'none',
                    letterSpacing: `${draft.spacing}px`,
                    color: assColorToCss(draft.primaryColor),
                    WebkitTextStroke: `${draft.outline}px ${assColorToCss(draft.outlineColor)}`,
                    textShadow: `${draft.shadow}px ${draft.shadow}px 0 ${assColorToCss(draft.backColor)}`,
                    whiteSpace: 'pre-line',
                    textAlign: 'center',
                  }}
                >
                  {previewText.replace(/\\N/g, '\n')}
                </span>
              </div>
              <div className="style-preview-controls">
                <input
                  value={previewText}
                  title={tPlain('Text to be used for the preview')}
                  aria-label={tPlain('Preview text')}
                  onChange={(event) => setPreviewText(event.target.value)}
                />
                <input
                  type="color"
                  title={tPlain('Color of preview background')}
                  aria-label={tPlain('Color of preview background')}
                  value={cssColorToHex(previewBg)}
                  onChange={(event) => {
                    const value = hexToCssColor(event.target.value)
                    setPreviewBg(value)
                    // 源码 OnPreviewColourChange：即时 OPT_SET
                    setOption('Colour/Style Editor/Background/Preview', value)
                  }}
                />
              </div>
            </fieldset>
          </div>
        </div>
        <footer>
          <button onClick={() => apply(true, true)}>{tPlain('OK')}</button>
          <button onClick={() => apply(false, true)}>{tPlain('Cancel')}</button>
          <button onClick={() => apply(true, false)}>{tPlain('Apply')}</button>
        </footer>
      </section>
      {conflict && (
        <StyleMessageBox
          title={tPlain('Style name conflict')}
          text={tPlain('There is already a style with this name. Please choose another name.')}
          buttons={['ok']}
          onAnswer={() => setConflict(false)}
        />
      )}
      {renamePrompt && (
        <StyleMessageBox
          title={tPlain('Update script?')}
          text={tPlain(
            'Do you want to change all instances of this style in the script to this new name?',
          )}
          buttons={['yes', 'no', 'cancel']}
          onAnswer={(answer) => {
            if (answer !== 'ok') answerRename(answer)
          }}
        />
      )}
    </div>
  )
}

/** wxMessageBox 等价物（OK / YES_NO_CANCEL） */
function StyleMessageBox({
  title,
  text,
  buttons,
  onAnswer,
}: {
  title: string
  text: string
  buttons: MessageBoxAnswer[]
  onAnswer: (answer: MessageBoxAnswer) => void
}) {
  // ESC = 最后一个按钮（OK 框为关闭、询问框为 Cancel）
  useEscapeClose(() => onAnswer(buttons[buttons.length - 1]))
  const label = (button: MessageBoxAnswer) =>
    tPlain(button === 'ok' ? 'OK' : button === 'yes' ? 'Yes' : button === 'no' ? 'No' : 'Cancel')
  return (
    <div className="dialog-backdrop nested">
      <section
        className="app-dialog style-message-box"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <strong>{title}</strong>
        </header>
        <p className="style-message-body">{text}</p>
        <footer>
          {buttons.map((button) => (
            <button key={button} onClick={() => onAnswer(button)}>
              {label(button)}
            </button>
          ))}
        </footer>
      </section>
    </div>
  )
}
