import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Copy, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { getOptionString, setOption } from '../../config/options'
import { createDefaultStyle } from '../../core/defaults'
import type { SubtitleStyle } from '../../core/types'
import {
  copyStyle,
  loadStyleCatalogs,
  saveStyleCatalogs,
  type StyleCatalog,
  uniqueStyleName,
} from '../../storage/styleCatalogStore'
import { assColorToCss, assColorToHex, hexToAssColor } from '../color'
import { tPlain } from '../i18n'

interface Props {
  styles: SubtitleStyle[]
  activeStyleName: string
  onClose: () => void
  onAdd: (style: SubtitleStyle) => void
  onUpdate: (id: string, patch: Partial<Omit<SubtitleStyle, 'id'>>) => void
  onDelete: (ids: string[]) => void
  onReorder: (ids: string[]) => void
}

type EditorTarget = {
  side: 'storage' | 'current'
  style: SubtitleStyle
  originalId?: string
} | null

function selectedValues(event: React.ChangeEvent<HTMLSelectElement>) {
  return [...event.target.selectedOptions].map((option) => option.value)
}

function reorder(
  styles: SubtitleStyle[],
  selected: string[],
  mode: 'up' | 'down' | 'top' | 'bottom' | 'sort',
) {
  if (mode === 'sort') return [...styles].sort((a, b) => a.name.localeCompare(b.name))
  const picked = styles.filter((style) => selected.includes(style.id))
  const rest = styles.filter((style) => !selected.includes(style.id))
  if (!picked.length) return styles
  if (mode === 'top') return [...picked, ...rest]
  if (mode === 'bottom') return [...rest, ...picked]
  const first = styles.findIndex((style) => selected.includes(style.id))
  let last = -1
  for (let index = styles.length - 1; index >= 0; index -= 1) {
    if (selected.includes(styles[index].id)) {
      last = index
      break
    }
  }
  if (mode === 'up' && first > 0) {
    const result = [...styles]
    const before = result.splice(first - 1, 1)[0]
    result.splice(last, 0, before)
    return result
  }
  if (mode === 'down' && last < styles.length - 1) {
    const result = [...styles]
    const after = result.splice(last + 1, 1)[0]
    result.splice(first, 0, after)
    return result
  }
  return styles
}

export function StyleManagerDialog({
  styles,
  activeStyleName,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
}: Props) {
  const [catalogs, setCatalogs] = useState<StyleCatalog[]>(loadStyleCatalogs)
  const [catalogName, setCatalogName] = useState(catalogs[0]?.name ?? 'Default')
  const catalog = catalogs.find((item) => item.name === catalogName) ?? catalogs[0]
  const [storageSelected, setStorageSelected] = useState<string[]>([])
  const active = styles.find((style) => style.name === activeStyleName) ?? styles[0]
  const [currentSelected, setCurrentSelected] = useState<string[]>(active ? [active.id] : [])
  const [editor, setEditor] = useState<EditorTarget>(null)
  // activeStyleName 变化时跟随当前选中（渲染期更新模式）
  const [prevActiveId, setPrevActiveId] = useState(active?.id ?? null)
  if ((active?.id ?? null) !== prevActiveId) {
    setPrevActiveId(active?.id ?? null)
    setCurrentSelected(active ? [active.id] : [])
  }
  const saveCatalogs = (next: StyleCatalog[]) => {
    setCatalogs(next)
    saveStyleCatalogs(next)
  }
  const updateCatalogStyles = (next: SubtitleStyle[]) =>
    saveCatalogs(
      catalogs.map((item) => (item.name === catalog.name ? { ...item, styles: next } : item)),
    )
  const selectedStorage = catalog.styles.filter((style) => storageSelected.includes(style.id))
  const selectedCurrent = styles.filter((style) => currentSelected.includes(style.id))
  const openNew = (side: 'storage' | 'current') =>
    setEditor({
      side,
      style: createDefaultStyle(
        uniqueStyleName('Default', side === 'storage' ? catalog.styles : styles),
      ),
    })
  const openCopy = (side: 'storage' | 'current') => {
    const source = side === 'storage' ? selectedStorage[0] : selectedCurrent[0]
    if (!source) return
    setEditor({ side, style: copyStyle(source, side === 'storage' ? catalog.styles : styles) })
  }
  const openEdit = (side: 'storage' | 'current') => {
    const source = side === 'storage' ? selectedStorage[0] : selectedCurrent[0]
    if (source) setEditor({ side, style: structuredClone(source), originalId: source.id })
  }
  const copyAcross = (from: 'storage' | 'current') => {
    const source = from === 'storage' ? selectedStorage : selectedCurrent
    const target = from === 'storage' ? styles : catalog.styles
    for (const style of source) {
      const existing = target.find(
        (item) => item.name.toLocaleLowerCase() === style.name.toLocaleLowerCase(),
      )
      if (from === 'storage') {
        if (existing) {
          const replacement = structuredClone(style) as Partial<Omit<SubtitleStyle, 'id'>> & {
            id?: string
          }
          delete replacement.id
          onUpdate(existing.id, replacement)
        } else onAdd({ ...structuredClone(style), id: `style-${crypto.randomUUID()}` })
      } else {
        updateCatalogStyles(
          existing
            ? target.map((item) =>
                item.id === existing.id ? { ...structuredClone(style), id: existing.id } : item,
              )
            : [...target, { ...structuredClone(style), id: `style-${crypto.randomUUID()}` }],
        )
      }
    }
  }
  return (
    <div className="dialog-backdrop">
      <section
        className="app-dialog style-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tPlain('Styles Manager')}
      >
        <header>
          <strong>{tPlain('Styles Manager')}</strong>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="style-manager-body">
          <fieldset className="style-catalog">
            <legend>{tPlain('Catalog of available storages')}</legend>
            <select value={catalog.name} onChange={(e) => setCatalogName(e.target.value)}>
              {catalogs.map((item) => (
                <option key={item.name}>{item.name}</option>
              ))}
            </select>
            <button
              onClick={() => {
                const name = prompt(tPlain('Catalog name'))
                if (
                  name?.trim() &&
                  !catalogs.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())
                ) {
                  const next = [...catalogs, { name: name.trim(), styles: [] }]
                  saveCatalogs(next)
                  setCatalogName(name.trim())
                }
              }}
            >
              {tPlain('New')}
            </button>
            <button
              disabled={catalogs.length <= 1}
              onClick={() => {
                const next = catalogs.filter((c) => c.name !== catalog.name)
                saveCatalogs(next)
                setCatalogName(next[0].name)
              }}
            >
              {tPlain('Delete')}
            </button>
          </fieldset>
          <div className="style-manager-columns">
            <StyleList
              title={tPlain('Storage')}
              styles={catalog.styles}
              selected={storageSelected}
              onSelect={setStorageSelected}
              onEdit={() => openEdit('storage')}
              onNew={() => openNew('storage')}
              onCopy={() => openCopy('storage')}
              onDelete={() =>
                updateCatalogStyles(catalog.styles.filter((s) => !storageSelected.includes(s.id)))
              }
              onMove={(mode) => updateCatalogStyles(reorder(catalog.styles, storageSelected, mode))}
            />
            <div className="style-copy-buttons">
              <button disabled={!storageSelected.length} onClick={() => copyAcross('storage')}>
                {tPlain('Copy to current script →')}
              </button>
              <button disabled={!currentSelected.length} onClick={() => copyAcross('current')}>
                {tPlain('← Copy to storage')}
              </button>
            </div>
            <StyleList
              title={tPlain('Current script')}
              styles={styles}
              selected={currentSelected}
              onSelect={setCurrentSelected}
              onEdit={() => openEdit('current')}
              onNew={() => openNew('current')}
              onCopy={() => openCopy('current')}
              onDelete={() => onDelete(currentSelected)}
              onMove={(mode) => onReorder(reorder(styles, currentSelected, mode).map((s) => s.id))}
            />
          </div>
        </div>
        <footer>
          <button onClick={onClose}>{tPlain('Close')}</button>
        </footer>
        {editor && (
          <StyleEditor
            style={editor.style}
            existing={editor.side === 'storage' ? catalog.styles : styles}
            onCancel={() => setEditor(null)}
            onApply={(style) => {
              if (editor.side === 'storage') {
                updateCatalogStyles(
                  editor.originalId
                    ? catalog.styles.map((item) =>
                        item.id === editor.originalId ? { ...style, id: item.id } : item,
                      )
                    : [...catalog.styles, style],
                )
              } else if (editor.originalId) onUpdate(editor.originalId, style)
              else onAdd(style)
              setEditor(null)
            }}
          />
        )}
      </section>
    </div>
  )
}

function StyleList(props: {
  title: string
  styles: SubtitleStyle[]
  selected: string[]
  onSelect: (ids: string[]) => void
  onEdit: () => void
  onNew: () => void
  onCopy: () => void
  onDelete: () => void
  onMove: (mode: 'up' | 'down' | 'top' | 'bottom' | 'sort') => void
}) {
  return (
    <fieldset className="style-list-panel">
      <legend>{props.title}</legend>
      <div className="style-list-main">
        <select
          multiple
          size={12}
          value={props.selected}
          onChange={(e) => props.onSelect(selectedValues(e))}
          onDoubleClick={props.onEdit}
        >
          {props.styles.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="style-move-buttons">
          <button onClick={() => props.onMove('up')} title={tPlain('Move up')}>
            <ArrowUp size={14} />
          </button>
          <button onClick={() => props.onMove('down')} title={tPlain('Move down')}>
            <ArrowDown size={14} />
          </button>
          <button onClick={() => props.onMove('top')} title={tPlain('Move to top')}>
            <ChevronsUp size={14} />
          </button>
          <button onClick={() => props.onMove('bottom')} title={tPlain('Move to bottom')}>
            <ChevronsDown size={14} />
          </button>
          <button onClick={() => props.onMove('sort')} title={tPlain('Sort alphabetically')}>
            A–Z
          </button>
        </div>
      </div>
      <div className="style-list-actions">
        <button onClick={props.onNew}>
          <Plus size={14} />
          {tPlain('New')}
        </button>
        <button disabled={props.selected.length !== 1} onClick={props.onEdit}>
          {tPlain('Edit')}
        </button>
        <button disabled={props.selected.length !== 1} onClick={props.onCopy}>
          <Copy size={14} />
          {tPlain('Copy')}
        </button>
        <button disabled={!props.selected.length} onClick={props.onDelete}>
          <Trash2 size={14} />
          {tPlain('Delete')}
        </button>
      </div>
    </fieldset>
  )
}

function StyleEditor({
  style,
  existing,
  onCancel,
  onApply,
}: {
  style: SubtitleStyle
  existing: SubtitleStyle[]
  onCancel: () => void
  onApply: (style: SubtitleStyle) => void
}) {
  const [draft, setDraft] = useState(structuredClone(style))
  // 预览文本（dialog_style_editor.cpp PreviewText：OPT_GET 初值 + 析构 OPT_SET）
  const [previewText, setPreviewText] = useState(() =>
    getOptionString('Tool/Style Editor/Preview Text'),
  )
  const previewTextRef = useRef('')
  useEffect(() => {
    previewTextRef.current = previewText
  })
  useEffect(
    () => () => {
      setOption('Tool/Style Editor/Preview Text', previewTextRef.current)
    },
    [],
  )
  const patch = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const valid = !existing.some(
    (item) => item.id !== style.id && item.name.toLowerCase() === draft.name.trim().toLowerCase(),
  )
  const color = (
    key: 'primaryColor' | 'secondaryColor' | 'outlineColor' | 'backColor',
    label: string,
  ) => (
    <label className="style-color-field">
      <span style={{ background: assColorToCss(draft[key]) }} />
      {tPlain(label)}
      <input
        type="color"
        value={assColorToHex(draft[key])}
        onChange={(e) => patch(key, hexToAssColor(e.target.value, draft[key]))}
      />
    </label>
  )
  return (
    <div className="dialog-backdrop nested">
      <section className="app-dialog style-editor-dialog">
        <header>
          <strong>{tPlain('Style Editor')}</strong>
        </header>
        <div className="style-editor-grid">
          <fieldset>
            <legend>{tPlain('Style name')}</legend>
            <input value={draft.name} onChange={(e) => patch('name', e.target.value)} />
          </fieldset>
          <fieldset>
            <legend>{tPlain('Font')}</legend>
            <label>
              {tPlain('Face')}
              <input value={draft.fontName} onChange={(e) => patch('fontName', e.target.value)} />
            </label>
            <label>
              {tPlain('Size')}
              <input
                type="number"
                min={0}
                max={10000}
                value={draft.fontSize}
                onChange={(e) => patch('fontSize', +e.target.value)}
              />
            </label>
            <div className="style-checks">
              {(['bold', 'italic', 'underline', 'strikeout'] as const).map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={draft[k]}
                    onChange={(e) => patch(k, e.target.checked)}
                  />
                  {k}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{tPlain('Colors')}</legend>
            {color('primaryColor', 'Primary')}
            {color('secondaryColor', 'Secondary')}
            {color('outlineColor', 'Outline')}
            {color('backColor', 'Shadow')}
          </fieldset>
          <fieldset>
            <legend>{tPlain('Margins')}</legend>
            {(['marginL', 'marginR', 'marginV'] as const).map((k) => (
              <label key={k}>
                {k}
                <input
                  type="number"
                  min={-9999}
                  max={99999}
                  value={draft[k]}
                  onChange={(e) => patch(k, +e.target.value)}
                />
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{tPlain('Alignment')}</legend>
            <div className="alignment-grid">
              {[7, 8, 9, 4, 5, 6, 1, 2, 3].map((n) => (
                <button
                  className={draft.alignment === n ? 'pressed' : ''}
                  onClick={() => patch('alignment', n)}
                  key={n}
                >
                  {n}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{tPlain('Outline')}</legend>
            <label>
              {tPlain('Outline')}
              <input
                type="number"
                min={0}
                max={1000}
                step={0.1}
                value={draft.outline}
                onChange={(e) => patch('outline', +e.target.value)}
              />
            </label>
            <label>
              {tPlain('Shadow')}
              <input
                type="number"
                min={0}
                max={1000}
                step={0.1}
                value={draft.shadow}
                onChange={(e) => patch('shadow', +e.target.value)}
              />
            </label>
            <label>
              {tPlain('Border style')}
              <select
                value={draft.borderStyle}
                onChange={(e) => patch('borderStyle', +e.target.value)}
              >
                <option value={1}>{tPlain('Outline')}</option>
                <option value={3}>{tPlain('Opaque box')}</option>
                <option value={4}>{tPlain('Shadow box')}</option>
              </select>
            </label>
          </fieldset>
          <fieldset>
            <legend>{tPlain('Miscellaneous')}</legend>
            {(['scaleX', 'scaleY', 'spacing', 'angle', 'encoding'] as const).map((k) => (
              <label key={k}>
                {k}
                <input type="number" value={draft[k]} onChange={(e) => patch(k, +e.target.value)} />
              </label>
            ))}
          </fieldset>
          <fieldset className="style-preview">
            <legend>{tPlain('Preview')}</legend>
            {/* PreviewText 输入框（dialog_style_editor.cpp）：\N 换行语义 */}
            <input
              value={previewText}
              onChange={(event) => setPreviewText(event.target.value)}
              aria-label={tPlain('Preview text')}
            />
            <div
              style={{
                fontFamily: draft.fontName,
                fontSize: Math.min(48, draft.fontSize),
                fontWeight: draft.bold ? 'bold' : 'normal',
                fontStyle: draft.italic ? 'italic' : 'normal',
                color: assColorToCss(draft.primaryColor),
                WebkitTextStroke: `${draft.outline}px ${assColorToCss(draft.outlineColor)}`,
                whiteSpace: 'pre-line',
              }}
            >
              {previewText.replace(/\\N/g, '\n')}
            </div>
          </fieldset>
        </div>
        <footer>
          <button
            disabled={!valid || !draft.name.trim()}
            onClick={() => onApply({ ...draft, name: draft.name.trim() })}
          >
            {tPlain('OK')}
          </button>
          <button onClick={onCancel}>{tPlain('Cancel')}</button>
        </footer>
      </section>
    </div>
  )
}
