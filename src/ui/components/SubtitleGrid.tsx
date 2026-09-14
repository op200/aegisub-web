import { useEffect, useMemo, useRef, useState } from 'react'

import { getOptionBool, getOptionInt, getOptionString } from '../../config/options'
import { formatEditorTime } from '../../core/time'
import type { SubtitleCue } from '../../core/types'
import type { Framerate } from '../../core/vfr'
import { getGridContext } from '../aegisubMenus'
import type { GridTagsMode } from '../commandRegistry'
import { COMMANDS } from '../commands'
import { tPlain, useLocaleVersion } from '../i18n'
import { MenuPopup } from './MenuPopup'

interface SubtitleGridProps {
  cues: SubtitleCue[]
  activeId: string | null
  selectedIds: Set<string>
  currentTimeMs: number
  textMode: GridTagsMode
  frameRate: Framerate
  frameMode: boolean
  /** 视频已加载（IsDisplayed 前置条件：无视频不高亮 in-frame 行） */
  hasVideo: boolean
  onSelect: (id: string, modifiers: { toggle: boolean; range: boolean }) => void
  /** 块选（拖动）：anchor..row，union = ctrl 并集；App 端负责把锚点恢复为 fromId */
  onSelectRange: (fromId: string, toId: string, union: boolean) => void
  /** 当前锚点行（base_grid.cpp extendRow：shift 扩选/拖动块的起点） */
  getAnchorId: () => string | null
  onActivate: (cue: SubtitleCue) => void
  onSetActive: (id: string) => void
  onCommand: (id: string) => void
  isCommandEnabled: (id: string) => boolean
}

interface GridColumnDef {
  key: string
  label: string
  /** grid_column.cpp 的列描述（列显隐菜单标题） */
  description: string
  centered?: boolean
  /** 内容驱动宽度的最小值（填充列 = 最小宽） */
  width: number
  /** Aegisub GridColumnText::Width()=5000：吸收全部剩余横向空间 */
  fill?: boolean
  /** GridColumn::CanHide：Text 列不可隐藏 */
  canHide?: boolean
}

/** Aegisub 网格列（顺序与 GetGridColumns 一致） */
const GRID_COLUMNS: GridColumnDef[] = [
  {
    key: 'number',
    label: '#',
    description: 'Line Number',
    centered: true,
    width: 0,
    canHide: true,
  },
  { key: 'layer', label: 'L', description: 'Layer', centered: true, width: 0, canHide: true },
  { key: 'start', label: 'Start', description: 'Start Time', width: 0, canHide: true },
  { key: 'end', label: 'End', description: 'End Time', width: 0, canHide: true },
  {
    key: 'cps',
    label: 'CPS',
    description: 'Characters Per Second',
    centered: true,
    width: 0,
    canHide: true,
  },
  { key: 'style', label: 'Style', description: 'Style', width: 0, canHide: true },
  { key: 'actor', label: 'Actor', description: 'Actor', width: 0, canHide: true },
  { key: 'effect', label: 'Effect', description: 'Effect', width: 0, canHide: true },
  {
    key: 'marginL',
    label: 'Left',
    description: 'Left Margin',
    centered: true,
    width: 0,
    canHide: true,
  },
  {
    key: 'marginR',
    label: 'Right',
    description: 'Right Margin',
    centered: true,
    width: 0,
    canHide: true,
  },
  {
    key: 'marginV',
    label: 'Vert',
    description: 'Vertical Margin',
    centered: true,
    width: 0,
    canHide: true,
  },
  { key: 'text', label: 'Text', description: 'Text', width: 160, fill: true, canHide: false },
]

const ROW_HEIGHT = 19
const OVERSCAN = 8

/** 网格字体（Subtitle/Grid/Font Face + Font Size；9pt → 12px） */
function gridFont(): string {
  const face = getOptionString('Subtitle/Grid/Font Face')
  const size = Math.round((getOptionInt('Subtitle/Grid/Font Size') * 4) / 3)
  return `${size}px ${face ? `"${face}", ` : ''}'Segoe UI', 'Microsoft YaHei UI', sans-serif`
}

/** 表头字体（.subtitle-grid-header：12px/600，继承全局字体栈，不随 Font Size 选项） */
function headerFont(): string {
  return `600 12px 'Segoe UI', 'Microsoft YaHei UI', Arial, sans-serif`
}

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string = gridFont()): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = font
  return measureCtx.measureText(text).width
}
function maxTextWidth(values: string[]): number {
  let max = 0
  for (const value of values) {
    if (!value) continue
    max = Math.max(max, textWidth(value))
  }
  return max
}

/**
 * Aegisub GridColumn::UpdateWidth：width = 10 + max(内容宽, 表头宽)。
 * web 移植按真实渲染占用取值：单元格 6+6（居中列 2+2）内边距 + 1px 右边框，
 * 表头按 12px/600 实测（翻译后 CJK 列名更宽，须保证不换行）；
 * 内容为空（Layer/边距全 0）时列宽为 0 → 列折叠隐藏。
 * 帧模式下 Start/End 列宽按最大帧号计算（grid_column.cpp）。
 */
function computeGridWidths(
  cues: SubtitleCue[],
  frameRate?: Framerate,
  frameMode?: boolean,
): { widths: number[]; fixedWidth: number } {
  const maxFrameText =
    frameMode && frameRate?.isLoaded()
      ? String(Math.max(...cues.map((cue) => frameRate.frameAtTime(cue.endMs, 'end')), 0))
      : ''
  const widths = GRID_COLUMNS.map((column) => {
    if (column.fill) return column.width
    let content = 0
    switch (column.key) {
      case 'number':
        content = textWidth(cues.length ? String(cues.length) : '1')
        break
      case 'layer': {
        const max = cues.reduce((m, cue) => Math.max(m, cue.layer), 0)
        content = max ? textWidth(String(max)) : 0
        break
      }
      case 'start':
      case 'end':
        content = maxFrameText ? textWidth(maxFrameText) : textWidth('0:00:00.00')
        break
      case 'cps':
        content = textWidth('999')
        break
      case 'style':
        content = maxTextWidth(cues.map((cue) => cue.style))
        break
      case 'actor':
        content = maxTextWidth(cues.map((cue) => cue.actor))
        break
      case 'effect':
        content = maxTextWidth(cues.map((cue) => cue.effect))
        break
      case 'marginL':
      case 'marginR':
      case 'marginV': {
        const index = column.key === 'marginL' ? 0 : column.key === 'marginR' ? 1 : 2
        const max = cues.reduce(
          (m, cue) =>
            Math.max(
              m,
              cue.marginL * 0 +
                (index === 0 ? cue.marginL : index === 1 ? cue.marginR : cue.marginV),
            ),
          0,
        )
        content = max ? textWidth(String(max)) : 0
        break
      }
      default:
        content = 0
    }
    if (!content) return 0
    const headerNeed = textWidth(tPlain(column.label), headerFont()) + 13
    const contentNeed = content + (column.centered ? 5 : 13)
    return Math.ceil(Math.max(headerNeed, contentNeed))
  })
  const fixedWidth = widths.filter((_, i) => !GRID_COLUMNS[i].fill).reduce((sum, w) => sum + w, 0)
  return { widths, fixedWidth }
}

/** 近似 CPS：去掉 override 块后按字符数估算 */
function cpsOf(cue: SubtitleCue): number | null {
  const duration = cue.endMs - cue.startMs
  if (duration <= 100) return null
  const text = cue.text.replace(/\{[^}]*\}/g, '').replace(/\\(N|n|h)/g, '')
  if (!text) return null
  if (text.length > duration) return null
  return Math.round((text.length * 1000) / duration)
}

function cellValue(
  cue: SubtitleCue,
  key: string,
  frameRate: Framerate,
  frameMode: boolean,
): string {
  switch (key) {
    case 'layer':
      // Aegisub GridColumnLayer：值为 0 时显示为空
      return cue.layer ? String(cue.layer) : ''
    case 'start':
      // 帧模式：FrameAtTime(Start, START)（grid_column.cpp L156-159）
      return frameMode && frameRate.isLoaded()
        ? String(frameRate.frameAtTime(cue.startMs, 'start'))
        : formatEditorTime(cue.startMs)
    case 'end':
      // 帧模式：FrameAtTime(End, END)
      return frameMode && frameRate.isLoaded()
        ? String(frameRate.frameAtTime(cue.endMs, 'end'))
        : formatEditorTime(cue.endMs)
    case 'style':
      return cue.style
    case 'actor':
      return cue.actor || '\u00a0'
    case 'effect':
      return cue.effect || '\u00a0'
    case 'marginL':
      // Aegisub GridColumnMargin：值为 0 时显示为空
      return cue.marginL ? String(cue.marginL) : ''
    case 'marginR':
      return cue.marginR ? String(cue.marginR) : ''
    case 'marginV':
      return cue.marginV ? String(cue.marginV) : ''
    default:
      return ''
  }
}

/** 按标签显示模式渲染文本（Aegisub Subtitle/Grid/Hide Overrides：0 显示 / 1 简化 / 2 隐藏） */
function displayText(text: string, mode: GridTagsMode): string {
  if (mode === 'show') return text.replaceAll('\\N', ' / ')
  if (mode === 'hide') {
    // 隐藏：删除所有 override 块
    const stripped = text.replace(/\{[^}]*}/g, '')
    return stripped.replaceAll('\\N', ' / ')
  }
  // 简化：每个 override 块替换为占位符（Subtitle/Grid/Hide Overrides Char）
  const simplified = text.replace(/\{[^}]*}/g, getOptionString('Subtitle/Grid/Hide Overrides Char'))
  return simplified.replaceAll('\\N', ' / ')
}

export function SubtitleGrid({
  cues,
  activeId,
  selectedIds,
  currentTimeMs,
  textMode,
  frameRate,
  frameMode,
  hasVideo,
  onSelect,
  onSelectRange,
  getAnchorId,
  onActivate,
  onSetActive,
  onCommand,
  isCommandEnabled,
}: SubtitleGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(300)
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  // 表头右键菜单（base_grid.cpp OnContextMenu：表头 → 列显隐菜单）
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set())
  // 拖动块选（base_grid.cpp holding 状态：锚点行 + 上次停留行）
  const dragRef = useRef<{ anchorIndex: number; anchorId: string } | null>(null)
  const dragLastRowRef = useRef(-1)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height))
    if (viewportRef.current) observer.observe(viewportRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.grid-context-menu')) {
        setContext(null)
        setHeaderMenu(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContext(null)
        setHeaderMenu(null)
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(cues.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
    return { start, end }
  }, [cues.length, height, scrollTop])

  const toggleColumn = (key: string) => {
    setHiddenColumns((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 语言切换时重算列宽：翻译后列名宽度不同（App 根部已订阅，此处取版本号进 memo 依赖）
  const localeVersion = useLocaleVersion()

  // Aegisub GridColumn::UpdateWidth：内容驱动列宽（Text 列填充剩余）
  const { widths, fixedWidth } = useMemo(
    () => computeGridWidths(cues, frameRate, frameMode),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- localeVersion 仅为触发列宽重算
    [cues, frameRate, frameMode, localeVersion],
  )
  const isHidden = (column: GridColumnDef, index: number) =>
    hiddenColumns.has(column.key) || (!column.fill && widths[index] === 0)
  const cellStyle = (column: GridColumnDef, index: number) =>
    column.fill
      ? { flex: '1 1 0%', minWidth: column.width }
      : { width: isHidden(column, index) ? 0 : widths[index] }

  // ---- 鼠标选择（对齐 base_grid.cpp OnMouseEvent）----
  const rowFromClientY = (clientY: number): number => {
    const viewport = viewportRef.current
    if (!viewport) return -1
    const rect = viewport.getBoundingClientRect()
    return Math.floor((clientY - rect.top + viewport.scrollTop) / ROW_HEIGHT)
  }

  // MakeRowVisible：行不可见时滚动（row-1 / 可见行数-3 边距语义）
  const makeRowVisible = (row: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const visibleRows = Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT))
    const first = Math.floor(viewport.scrollTop / ROW_HEIGHT)
    if (row < first + 1) scrollToRow(row - 1)
    else if (row > first + visibleRows - 3) scrollToRow(row - visibleRows + 3)
  }

  const scrollToRow = (row: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const clamped = Math.max(0, Math.min(row, Math.max(0, cues.length - 1)))
    viewport.scrollTop = clamped * ROW_HEIGHT
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    // 源码 LeftUp：MakeRowVisible(mid(0, row, GetRows()-1))，按释放位置取行
    const row = Math.max(0, Math.min(rowFromClientY(event.clientY), cues.length - 1))
    makeRowVisible(row)
    dragLastRowRef.current = -1
  }

  // 双击处理挂 viewport 委托：行的 pointerdown 会 setPointerCapture，dblclick 被
  // 重定向到 capture 元素（行上的监听永远收不到）。base_grid.cpp OnMouseEvent dclick
  // 分支：无修饰键时 ScrollToActiveLine + JumpToTime(Start) + SelectRow（onActivate）
  const onViewportDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    const cue = cues[rowFromClientY(event.clientY)]
    if (!cue) return
    onActivate(cue)
  }

  const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // 只在行上起效（点空白/滚动条不改变选区，同源码 dlg 为空时跳过）
    const target = event.target as HTMLElement
    if (!target.closest('.subtitle-row')) return
    const index = rowFromClientY(event.clientY)
    const cue = cues[index]
    if (!cue) return
    const shift = event.shiftKey
    const ctrl = event.ctrlKey || event.metaKey
    const alt = event.altKey
    // 锚点取当前 extendRow；行已删除或为空时退回点击行
    const anchorId = getAnchorId()
    const validAnchor = anchorId && cues.some((c) => c.id === anchorId) ? anchorId : cue.id
    // 源码 extendRow 在本事件内先设为点击行，仅 shift 块选分支恢复 old_extend：
    // 拖动块选锚点 = shift+单击 ? 原锚点行 : 点击行（plain/ctrl/alt 都以点击行为锚）
    const blockAnchorId = shift && !alt ? validAnchor : cue.id
    const blockAnchorIndex =
      shift && !alt
        ? Math.max(
            0,
            cues.findIndex((c) => c.id === validAnchor),
          )
        : index
    dragRef.current = { anchorIndex: blockAnchorIndex, anchorId: blockAnchorId }
    dragLastRowRef.current = index
    event.currentTarget.setPointerCapture(event.pointerId)
    if (ctrl && !shift && !alt) onSelect(cue.id, { toggle: true, range: false })
    else if (shift && !alt) onSelectRange(validAnchor, cue.id, ctrl)
    else if (alt && !shift && !ctrl) onSetActive(cue.id)
    else onSelect(cue.id, { toggle: false, range: false })
  }

  const onViewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    // holding 期间行号钳制到合法范围（源码 mid(0, row, GetRows()-1)）
    const row = Math.max(0, Math.min(rowFromClientY(event.clientY), cues.length - 1))
    // 滚动检查每次 move 都执行，与"是否换行"无关（源码 row != extendRow，锚点为比较基准）
    if (row !== drag.anchorIndex) {
      const viewport = viewportRef.current
      if (viewport) {
        // 边缘自动滚动（源码 ScrollTo(yPos ± 3)）
        const yPos = Math.floor(viewport.scrollTop / ROW_HEIGHT)
        const visibleRows = Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT))
        if (row <= yPos) scrollToRow(yPos - 3)
        else if (row > yPos + visibleRows - (row > drag.anchorIndex ? 3 : 1)) scrollToRow(yPos + 3)
      }
    }
    if (row === dragLastRowRef.current) return
    dragLastRowRef.current = row
    const cue = cues[row]
    if (!cue) return
    // 活动行跟随鼠标（源码每次 mouse move SetActiveLine）
    onSelectRange(drag.anchorId, cue.id, event.ctrlKey || event.metaKey)
  }

  // base_grid.cpp OnKeyDown：方向/翻页/行首行尾移动，Alt 仅移活动行，Shift 扩选
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || (event.altKey && event.shiftKey)) return
    const activeIndex = Math.max(
      0,
      cues.findIndex((cue) => cue.id === activeId),
    )
    const pageSize = Math.max(1, Math.floor(height / ROW_HEIGHT) - 2)
    let direction = 0
    let step = 1
    if (event.key === 'ArrowUp') direction = -1
    else if (event.key === 'ArrowDown') direction = 1
    else if (event.key === 'PageUp') {
      direction = -1
      step = pageSize
    } else if (event.key === 'PageDown') {
      direction = 1
      step = pageSize
    } else if (event.key === 'Home') {
      direction = -1
      step = cues.length
    } else if (event.key === 'End') {
      direction = 1
      step = cues.length
    } else return
    if (!cues.length) return
    event.preventDefault()
    event.stopPropagation()
    const nextIndex = Math.max(0, Math.min(cues.length - 1, activeIndex + direction * step))
    const next = cues[nextIndex]
    if (!next) return
    if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      onSetActive(next.id)
      return
    }
    if (event.shiftKey && !event.altKey && activeId) {
      onSelect(next.id, { toggle: false, range: true })
      makeRowVisible(nextIndex)
      return
    }
    onSelect(next.id, { toggle: false, range: false })
  }

  return (
    <section className="grid-panel" aria-label={tPlain('Subtitle lines')}>
      <div className="subtitle-grid-scroll">
        <div className="subtitle-grid-minwidth" style={{ minWidth: fixedWidth }}>
          <div
            className="subtitle-grid-header grid-columns"
            role="row"
            onContextMenu={(event) => event.preventDefault()}
          >
            {GRID_COLUMNS.map((column, index) => (
              <span
                className={`grid-header-cell${column.fill ? ' grid-fill' : ''}${isHidden(column, index) ? ' grid-hidden' : ''}`}
                style={cellStyle(column, index)}
                role="columnheader"
                key={column.key}
                title={tPlain(column.description)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setHeaderMenu({ x: event.clientX, y: event.clientY })
                }}
              >
                {tPlain(column.label)}
              </span>
            ))}
          </div>
          <div
            ref={viewportRef}
            className="subtitle-grid-viewport"
            tabIndex={0}
            data-shortcut-context="Subtitle Grid"
            onPointerDown={onViewportPointerDown}
            onPointerMove={onViewportPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onViewportDoubleClick}
            onPointerDownCapture={() => {
              // Subtitle/Grid/Focus Allow：关闭时点击不夺取焦点（基_grid FocusGrid）
              if (getOptionBool('Subtitle/Grid/Focus Allow')) viewportRef.current?.focus()
            }}
            onKeyDown={moveByKeyboard}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            role="grid"
            aria-rowcount={cues.length}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div style={{ height: cues.length * ROW_HEIGHT, position: 'relative' }}>
              {(() => {
                // 当前视频帧号（IsDisplayed 按帧号比较，与行无关，提出循环）
                const frameNow =
                  hasVideo && frameRate.isLoaded() ? frameRate.frameAtTime(currentTimeMs) : null
                return cues.slice(range.start, range.end).map((cue, offset) => {
                  const index = range.start + offset
                  // Subtitle/Grid/Highlight Subtitles in Frame：当前帧可见行高亮
                  // IsDisplayed（base_grid.cpp）：按帧号比较 FrameAtTime(Start/End)，
                  // 不排除注释行，且需要视频已加载
                  const activeAtTime =
                    frameNow !== null &&
                    getOptionBool('Subtitle/Grid/Highlight Subtitles in Frame') &&
                    frameRate.frameAtTime(cue.startMs, 'start') <= frameNow &&
                    frameRate.frameAtTime(cue.endMs, 'end') >= frameNow
                  const cps = cpsOf(cue)
                  return (
                    <div
                      key={cue.id}
                      className={`subtitle-row grid-columns${selectedIds.has(cue.id) ? ' selected' : ''}${cue.id === activeId ? ' active' : ''}${activeAtTime ? ' at-time' : ''}${cue.comment ? ' comment' : ''}`}
                      style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                      role="row"
                      aria-rowindex={index + 1}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        if (!selectedIds.has(cue.id))
                          onSelect(cue.id, { toggle: false, range: false })
                        setContext({ x: event.clientX, y: event.clientY })
                      }}
                    >
                      <span className="row-number" style={{ width: widths[0] }}>
                        {index + 1}
                      </span>
                      {GRID_COLUMNS.slice(1).map((column, colOffset) => {
                        const colIndex = colOffset + 1
                        const cls = `${column.fill ? 'grid-fill' : ''}${isHidden(column, colIndex) ? ' grid-hidden' : ''}`
                        if (column.key === 'cps') {
                          // 超过 CPS Error Threshold 时用 Colour/Subtitle Grid/CPS Error 着色
                          const cpsError = getOptionInt(
                            'Subtitle/Character Counter/CPS Error Threshold',
                          )
                          const over = cps !== null && cps > cpsError
                          return (
                            <span
                              className={`grid-cell-centered grid-cps ${cls}${over ? ' cps-error' : ''}`}
                              style={cellStyle(column, colIndex)}
                              key={column.key}
                            >
                              {cps ?? ''}
                            </span>
                          )
                        }
                        if (column.key === 'text') {
                          const shown = displayText(cue.text, textMode)
                          return (
                            <span
                              className={`cue-text ${cls}`}
                              style={cellStyle(column, colIndex)}
                              key={column.key}
                              title={cue.text}
                            >
                              {shown || '\u00a0'}
                            </span>
                          )
                        }
                        return (
                          <span
                            className={`${column.centered ? 'grid-cell-centered' : ''} ${cls}`}
                            style={cellStyle(column, colIndex)}
                            key={column.key}
                          >
                            {cellValue(cue, column.key, frameRate, frameMode)}
                          </span>
                        )
                      })}
                    </div>
                  )
                })
              })()}
            </div>
          </div>
        </div>
      </div>

      {headerMenu && (
        <MenuPopup x={headerMenu.x} y={headerMenu.y} label={tPlain('Show column')}>
          {GRID_COLUMNS.filter((column) => column.canHide).map((column) => (
            <button
              className="menu-item"
              role="menuitemcheckbox"
              aria-checked={!hiddenColumns.has(column.key)}
              key={column.key}
              onClick={() => toggleColumn(column.key)}
            >
              <span className="menu-check">{!hiddenColumns.has(column.key) ? '✓' : ''}</span>
              <span className="menu-label">{tPlain(column.description)}</span>
            </button>
          ))}
        </MenuPopup>
      )}

      {context && (
        <MenuPopup x={context.x} y={context.y} label={tPlain('Grid context menu')}>
          {getGridContext().map((item, index) => {
            if (item.separator)
              return <div className="menu-separator" role="separator" key={`sep-${index}`} />
            if (!item.command)
              return (
                <button className="menu-item" role="menuitem" disabled key={index}>
                  <span className="menu-label">{item.label}</span>
                </button>
              )
            return (
              <button
                className="menu-item"
                role="menuitem"
                key={item.command}
                disabled={!isCommandEnabled(item.command)}
                onClick={() => {
                  if (!isCommandEnabled(item.command!)) return
                  setContext(null)
                  onCommand(item.command!)
                }}
              >
                <span className="menu-label">
                  {item.label ?? tPlain(COMMANDS[item.command]?.label ?? item.command)}
                </span>
              </button>
            )
          })}
        </MenuPopup>
      )}
    </section>
  )
}
