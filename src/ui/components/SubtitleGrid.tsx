import { useEffect, useMemo, useRef, useState } from 'react';
import type { SortColumn, SubtitleCue } from '../../core/types';
import { formatEditorTime } from '../../core/time';
import { AEGISUB_GRID_CONTEXT } from '../aegisubMenus';
import { COMMANDS } from '../commands';
import type { GridTagsMode } from '../commandRegistry';

interface SubtitleGridProps {
  cues: SubtitleCue[];
  activeId: string | null;
  selectedIds: Set<string>;
  currentTimeMs: number;
  textMode: GridTagsMode;
  onSelect: (id: string, modifiers: { toggle: boolean; range: boolean }) => void;
  onActivate: (cue: SubtitleCue) => void;
  onSetActive: (id: string) => void;
  onSortColumn: (column: SortColumn) => void;
  onCommand: (id: string) => void;
  isCommandEnabled: (id: string) => boolean;
}

interface GridColumnDef {
  key: string;
  label: string;
  sortKey?: SortColumn;
  centered?: boolean;
  /** 内容驱动宽度的最小值（填充列 = 最小宽） */
  width: number;
  /** Aegisub GridColumnText::Width()=5000：吸收全部剩余横向空间 */
  fill?: boolean;
}

/** Aegisub 网格列（顺序与 GetGridColumns 一致） */
const GRID_COLUMNS: GridColumnDef[] = [
  { key: 'number', label: '#', centered: true, width: 0 },
  { key: 'layer', label: 'L', sortKey: 'layer', centered: true, width: 0 },
  { key: 'start', label: 'Start', sortKey: 'start', width: 0 },
  { key: 'end', label: 'End', sortKey: 'end', width: 0 },
  { key: 'cps', label: 'CPS', centered: true, width: 0 },
  { key: 'style', label: 'Style', sortKey: 'style', width: 0 },
  { key: 'actor', label: 'Actor', sortKey: 'actor', width: 0 },
  { key: 'effect', label: 'Effect', sortKey: 'effect', width: 0 },
  { key: 'marginL', label: 'Left', centered: true, width: 0 },
  { key: 'marginR', label: 'Right', centered: true, width: 0 },
  { key: 'marginV', label: 'Vert', centered: true, width: 0 },
  { key: 'text', label: 'Text', width: 160, fill: true },
];

const ROW_HEIGHT = 19;
const OVERSCAN = 8;

/** 网格字体（Subtitle/Grid/Font Size = 9pt → 12px） */
const GRID_FONT = "12px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = GRID_FONT;
  return measureCtx.measureText(text).width;
}
function maxTextWidth(values: string[]): number {
  let max = 0;
  for (const value of values) {
    if (!value) continue;
    max = Math.max(max, textWidth(value));
  }
  return max;
}

/**
 * Aegisub GridColumn::UpdateWidth：width = 10 + max(内容宽, 表头宽)；
 * 内容为空（Layer/边距全 0）时列宽为 0 → 列折叠隐藏。
 */
function computeGridWidths(cues: SubtitleCue[]): { widths: number[]; fixedWidth: number } {
  const widths = GRID_COLUMNS.map((column) => {
    if (column.fill) return column.width;
    let content = 0;
    switch (column.key) {
      case 'number':
        content = textWidth(cues.length ? String(cues.length) : '1');
        break;
      case 'layer': {
        const max = cues.reduce((m, cue) => Math.max(m, cue.layer), 0);
        content = max ? textWidth(String(max)) : 0;
        break;
      }
      case 'start':
      case 'end':
        content = textWidth('0:00:00.00');
        break;
      case 'cps':
        content = textWidth('999');
        break;
      case 'style':
        content = maxTextWidth(cues.map((cue) => cue.style));
        break;
      case 'actor':
        content = maxTextWidth(cues.map((cue) => cue.actor));
        break;
      case 'effect':
        content = maxTextWidth(cues.map((cue) => cue.effect));
        break;
      case 'marginL':
      case 'marginR':
      case 'marginV': {
        const index = column.key === 'marginL' ? 0 : column.key === 'marginR' ? 1 : 2;
        const max = cues.reduce(
          (m, cue) =>
            Math.max(m, cue.marginL * 0 + (index === 0 ? cue.marginL : index === 1 ? cue.marginR : cue.marginV)),
          0,
        );
        content = max ? textWidth(String(max)) : 0;
        break;
      }
      default:
        content = 0;
    }
    if (!content) return 0;
    return Math.ceil(10 + Math.max(content, textWidth(column.label)));
  });
  const fixedWidth = widths.filter((_, i) => !GRID_COLUMNS[i].fill).reduce((sum, w) => sum + w, 0);
  return { widths, fixedWidth };
}

/** 近似 CPS：去掉 override 块后按字符数估算 */
function cpsOf(cue: SubtitleCue): number | null {
  const duration = cue.endMs - cue.startMs;
  if (duration <= 100) return null;
  const text = cue.text.replace(/\{[^}]*\}/g, '').replace(/\\(N|n|h)/g, '');
  if (!text) return null;
  if (text.length > duration) return null;
  return Math.round((text.length * 1000) / duration);
}

function cellValue(cue: SubtitleCue, key: string): string {
  switch (key) {
    case 'layer':
      // Aegisub GridColumnLayer：值为 0 时显示为空
      return cue.layer ? String(cue.layer) : '';
    case 'start':
      return formatEditorTime(cue.startMs);
    case 'end':
      return formatEditorTime(cue.endMs);
    case 'style':
      return cue.style;
    case 'actor':
      return cue.actor || '\u00a0';
    case 'effect':
      return cue.effect || '\u00a0';
    case 'marginL':
      // Aegisub GridColumnMargin：值为 0 时显示为空
      return cue.marginL ? String(cue.marginL) : '';
    case 'marginR':
      return cue.marginR ? String(cue.marginR) : '';
    case 'marginV':
      return cue.marginV ? String(cue.marginV) : '';
    default:
      return '';
  }
}

/** 按标签显示模式渲染文本（Aegisub Subtitle/Grid/Hide Overrides：0 显示 / 1 简化☀ / 2 隐藏） */
function displayText(text: string, mode: GridTagsMode): string {
  if (mode === 'show') return text.replaceAll('\\N', ' / ');
  if (mode === 'hide') {
    // 隐藏：删除所有 override 块
    const stripped = text.replace(/\{[^}]*}/g, '');
    return stripped.replaceAll('\\N', ' / ');
  }
  // 简化：每个 override 块替换为 ☀（Subtitle/Grid/Hide Overrides Char）
  const simplified = text.replace(/\{[^}]*}/g, '☀');
  return simplified.replaceAll('\\N', ' / ');
}

export function SubtitleGrid({
  cues,
  activeId,
  selectedIds,
  currentTimeMs,
  textMode,
  onSelect,
  onActivate,
  onSetActive,
  onSortColumn,
  onCommand,
  isCommandEnabled,
}: SubtitleGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.grid-context-menu')) setContext(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContext(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(cues.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    return { start, end };
  }, [cues.length, height, scrollTop]);

  const handleHeaderClick = (column: GridColumnDef) => {
    if (!column.sortKey) return;
    setSortColumn(column.sortKey);
    onSortColumn(column.sortKey);
  };

  const moveByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || (event.altKey && event.shiftKey)) return;
    const activeIndex = Math.max(
      0,
      cues.findIndex((cue) => cue.id === activeId),
    );
    const pageSize = Math.max(1, Math.floor(height / ROW_HEIGHT) - 2);
    let direction = 0;
    let step = 1;
    if (event.key === 'ArrowUp') direction = -1;
    else if (event.key === 'ArrowDown') direction = 1;
    else if (event.key === 'PageUp') {
      direction = -1;
      step = pageSize;
    } else if (event.key === 'PageDown') {
      direction = 1;
      step = pageSize;
    } else if (event.key === 'Home') {
      direction = -1;
      step = cues.length;
    } else if (event.key === 'End') {
      direction = 1;
      step = cues.length;
    } else return;
    if (!cues.length) return;
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = Math.max(0, Math.min(cues.length - 1, activeIndex + direction * step));
    const next = cues[nextIndex];
    if (!next) return;
    if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      onSetActive(next.id);
      return;
    }
    if (event.shiftKey && !event.altKey && activeId) {
      onSelect(next.id, { toggle: false, range: true });
      return;
    }
    onSelect(next.id, { toggle: false, range: false });
  };

  // Aegisub GridColumn::UpdateWidth：内容驱动列宽（Text 列填充剩余）
  const { widths, fixedWidth } = useMemo(() => computeGridWidths(cues), [cues]);
  const cellStyle = (column: GridColumnDef, index: number) =>
    column.fill ? { flex: '1 1 0%', minWidth: column.width } : { width: widths[index] };

  return (
    <section className="grid-panel" aria-label="Subtitle lines">
      <div className="subtitle-grid-scroll">
        <div className="subtitle-grid-minwidth" style={{ minWidth: fixedWidth }}>
          <div className="subtitle-grid-header grid-columns" role="row">
            {GRID_COLUMNS.map((column, index) => (
              <span
                className={`grid-header-cell${column.sortKey ? ' sortable' : ''}${sortColumn === column.sortKey ? ' sorted' : ''}${column.fill ? ' grid-fill' : ''}${widths[index] === 0 ? ' grid-hidden' : ''}`}
                style={cellStyle(column, index)}
                role="columnheader"
                key={column.key}
                title={column.sortKey ? `Sort by ${column.label}` : column.label}
                onClick={() => handleHeaderClick(column)}
              >
                {column.label}
              </span>
            ))}
          </div>
          <div
            ref={viewportRef}
            className="subtitle-grid-viewport"
            tabIndex={0}
            data-shortcut-context="Subtitle Grid"
            onPointerDown={(event) => event.currentTarget.focus()}
            onKeyDown={moveByKeyboard}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            role="grid"
            aria-rowcount={cues.length}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div style={{ height: cues.length * ROW_HEIGHT, position: 'relative' }}>
              {cues.slice(range.start, range.end).map((cue, offset) => {
                const index = range.start + offset;
                const activeAtTime = !cue.comment && cue.startMs <= currentTimeMs && cue.endMs >= currentTimeMs;
                const cps = cpsOf(cue);
                return (
                  <div
                    key={cue.id}
                    className={`subtitle-row grid-columns${selectedIds.has(cue.id) ? ' selected' : ''}${cue.id === activeId ? ' active' : ''}${activeAtTime ? ' at-time' : ''}${cue.comment ? ' comment' : ''}`}
                    style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                    role="row"
                    aria-rowindex={index + 1}
                    onClick={(event) =>
                      onSelect(cue.id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })
                    }
                    onDoubleClick={() => onActivate(cue)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!selectedIds.has(cue.id)) onSelect(cue.id, { toggle: false, range: false });
                      setContext({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="row-number" style={{ width: widths[0] }}>
                      {index + 1}
                    </span>
                    {GRID_COLUMNS.slice(1).map((column, colOffset) => {
                      const colIndex = colOffset + 1;
                      const cls = `${column.fill ? 'grid-fill' : ''}${widths[colIndex] === 0 ? ' grid-hidden' : ''}`;
                      if (column.key === 'cps') {
                        return (
                          <span
                            className={`grid-cell-centered grid-cps ${cls}`}
                            style={cellStyle(column, colIndex)}
                            key={column.key}
                          >
                            {cps ?? ''}
                          </span>
                        );
                      }
                      if (column.key === 'text') {
                        const shown = displayText(cue.text, textMode);
                        return (
                          <span
                            className={`cue-text ${cls}`}
                            style={cellStyle(column, colIndex)}
                            key={column.key}
                            title={cue.text}
                          >
                            {shown || '\u00a0'}
                          </span>
                        );
                      }
                      return (
                        <span
                          className={`${column.centered ? 'grid-cell-centered' : ''} ${cls}`}
                          style={cellStyle(column, colIndex)}
                          key={column.key}
                        >
                          {cellValue(cue, column.key)}
                        </span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {context && (
        <div
          className="grid-context-menu"
          role="menu"
          aria-label="Grid context menu"
          style={{ left: context.x, top: context.y }}
        >
          {AEGISUB_GRID_CONTEXT.map((item, index) => {
            if (item.separator) return <div className="menu-separator" role="separator" key={`sep-${index}`} />;
            if (!item.command)
              return (
                <button className="menu-item" role="menuitem" disabled key={index}>
                  <span className="menu-label">{item.label}</span>
                </button>
              );
            return (
              <button
                className="menu-item"
                role="menuitem"
                key={item.command}
                disabled={!isCommandEnabled(item.command)}
                onClick={() => {
                  if (!isCommandEnabled(item.command!)) return;
                  setContext(null);
                  onCommand(item.command!);
                }}
              >
                <span className="menu-label">{item.label ?? COMMANDS[item.command]?.label ?? item.command}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
