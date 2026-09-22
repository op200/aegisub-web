import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Copy, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { createDefaultStyle } from '../../core/defaults'
import type { SubtitleStyle } from '../../core/types'
import {
  copyStyle,
  loadStyleCatalogs,
  saveStyleCatalogs,
  type StyleCatalog,
  uniqueStyleName,
} from '../../storage/styleCatalogStore'
import { tPlain } from '../i18n'
import { useEscapeClose } from './dialogs'
import { StyleEditorDialog } from './StyleEditorDialog'

interface Props {
  styles: SubtitleStyle[]
  activeStyleName: string
  onClose: () => void
  // label 覆写用于跨表复制（源码 dialog_style_manager.cpp CopyToCurrent = "style copy"），
  // 编辑面板保存/新建经 DialogStyleEditor 统一 "style change"
  onAdd: (style: SubtitleStyle, label?: string) => void
  onUpdate: (
    id: string,
    patch: Partial<Omit<SubtitleStyle, 'id'>>,
    label?: string,
    rename?: { from: string; to: string } | null,
  ) => void
  onDelete: (ids: string[]) => void
  onReorder: (ids: string[]) => void
  /** 源码 StyleRenamer::NeedsReplace（当前脚本内该样式是否存在引用） */
  hasReferences?: (name: string) => boolean
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
  hasReferences,
}: Props) {
  // ESC 关闭（嵌套 StyleEditor 后挂载于栈顶，先于主窗响应）
  useEscapeClose(onClose)
  const [catalogs, setCatalogs] = useState<StyleCatalog[]>(loadStyleCatalogs)
  const [catalogName, setCatalogName] = useState(catalogs[0]?.name ?? 'Default')
  const catalog = catalogs.find((item) => item.name === catalogName) ?? catalogs[0]
  const [storageSelected, setStorageSelected] = useState<string[]>([])
  const active = styles.find((style) => style.name === activeStyleName) ?? styles[0]
  const [currentSelected, setCurrentSelected] = useState<string[]>(active ? [active.id] : [])
  const [editor, setEditor] = useState<EditorTarget>(null)
  // 当前脚本侧编辑目标：WASM 核心的样式 id 即样式名（改名后随之变化），
  // 故先按 id 再按最近应用的名字回退解析，保证改名后仍指向同一样式（源码持 AssStyle*）
  const editorCurrent =
    editor?.side === 'current'
      ? (styles.find((item) => item.id === editor.originalId) ??
        styles.find((item) => item.name === editor.style.name) ??
        null)
      : null
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
          onUpdate(existing.id, replacement, 'style copy')
        } else
          onAdd({ ...structuredClone(style), id: `style-${crypto.randomUUID()}` }, 'style copy')
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
          <StyleEditorDialog
            nested
            style={editor.style}
            existing={editor.side === 'storage' ? catalog.styles : styles}
            originalId={editor.side === 'current' ? editorCurrent?.id : editor.originalId}
            storage={editor.side === 'storage'}
            hasReferences={hasReferences}
            onApply={(style, rename) => {
              if (editor.side === 'storage') {
                // 源码 store->push_back 接管同一对象：新建后身份即为该样式
                updateCatalogStyles(
                  editor.originalId
                    ? catalog.styles.map((item) =>
                        item.id === editor.originalId ? { ...style, id: item.id } : item,
                      )
                    : [...catalog.styles, style],
                )
                setEditor((current) =>
                  current
                    ? { ...current, style, originalId: current.originalId ?? style.id }
                    : current,
                )
              } else if (editor.originalId) {
                // 用解析到的最新 id 提交（WASM 核心改名后 id 随样式名变化）
                const target = editorCurrent ?? styles.find((item) => item.id === editor.originalId)
                if (target) onUpdate(target.id, style, undefined, rename)
                setEditor((current) => (current ? { ...current, style } : current))
              } else {
                onAdd(style)
                setEditor((current) => (current ? { ...current, style } : current))
              }
            }}
            onClose={() => setEditor(null)}
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
