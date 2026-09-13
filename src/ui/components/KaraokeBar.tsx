import { Check, X } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { Karaoke, roundCs, type KaraokeTagType } from '../../core/karaoke'
import type { SubtitleCue } from '../../core/types'
import { tPlain } from '../i18n'
import { SPLIT_BAR_PALETTES, useSystemTheme } from '../theme'
import { MenuPopup } from './MenuPopup'

/**
 * 卡拉OK条（对应 Aegisub audio_karaoke.cpp 的 split bar + AudioTimingControllerKaraoke 的时间轴）。
 *
 * 上半部分是"等宽字符槽"split bar：点击分隔线附近（±3px）删除分割，其它位置添加分割；
 * 下半部分是音节时间条：拖动黄色音节边界调整 \\k（10ms 取整、不可越过相邻边界、Ctrl 平移后续）。
 * 行首/行尾红蓝边界与源码一致，仅可视化不可拖。
 */
export interface KaraokeBarHandle {
  /** 有未提交修改时提交并返回 true（audio/commit 拦截用） */
  commitIfPending(): boolean
}

interface KaraokeBarProps {
  cue: SubtitleCue
  currentTimeMs: number
  autoCommit: boolean
  onPatchText: (text: string, label: string) => void
  onPendingChange?: (pending: boolean) => void
}

const SPLIT_HEIGHT = 26
const TIMING_HEIGHT = 46
const SEPARATOR_TOLERANCE = 3
const DRAG_SENSITIVITY_PX = 8

interface Slot {
  char: string
  /** 所属音节；-1 = 音节间空隙槽（归前一音节） */
  syl: number
  /** 添加分割时的文本插入位置（音节内字符索引） */
  pos: number
}

export const KaraokeBar = forwardRef<KaraokeBarHandle, KaraokeBarProps>(function KaraokeBar(
  { cue, currentTimeMs, autoCommit, onPatchText, onPendingChange },
  ref,
) {
  const karaRef = useRef<Karaoke | null>(null)
  const [splitsPending, setSplitsPending] = useState(false)
  const [timingPending, setTimingPending] = useState(false)
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number } | null>(null)
  const [tagType, setTagTypeState] = useState<KaraokeTagType>('\\k')
  const splitCanvasRef = useRef<HTMLCanvasElement>(null)
  const timingCanvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef<{ x: number; remove: boolean } | null>(null)
  const theme = useSystemTheme()
  const dragRef = useRef<{ marker: number } | null>(null)

  const reportPending = useCallback(
    (pending: boolean) => {
      onPendingChange?.(pending)
    },
    [onPendingChange],
  )

  const reload = useCallback(() => {
    karaRef.current = Karaoke.fromLine(cue.text, cue.startMs, cue.endMs)
    setSplitsPending(false)
    setTimingPending(false)
    setTagTypeState(karaRef.current.syllables[0]?.tagType ?? '\\k')
    reportPending(false)
  }, [cue.text, cue.startMs, cue.endMs, reportPending])

  useEffect(() => {
    reload()
    // 换行时有未提交的计时 → 先提交（audio_timing_karaoke 语义：pending 属于活动行）
    return () => {
      if (timingPending && karaRef.current) {
        onPatchText(karaRef.current.getText(), 'karaoke timing')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue.id])

  const commitSplits = useCallback(() => {
    if (!karaRef.current) return
    onPatchText(karaRef.current.getText(), 'karaoke split')
    setSplitsPending(false)
    reportPending(timingPending)
  }, [onPatchText, reportPending, timingPending])

  const cancelSplits = useCallback(() => {
    reload()
  }, [reload])

  useImperativeHandle(ref, () => ({
    commitIfPending: () => {
      if (!splitsPending && !timingPending) return false
      if (karaRef.current) onPatchText(karaRef.current.getText(), 'karaoke timing')
      setSplitsPending(false)
      setTimingPending(false)
      reportPending(false)
      return true
    },
  }))

  const markSplits = () => {
    setSplitsPending(true)
    reportPending(true)
  }

  // ---- split bar 绘制与交互 ----
  const buildLayout = useCallback(() => {
    const kara = karaRef.current!
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')!
    context.font = "12px 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    let charWidth = context.measureText(' ').width
    const slots: Slot[] = []
    const sylStartSlot: number[] = []
    kara.syllables.forEach((syl, index) => {
      sylStartSlot.push(slots.length)
      slots.push({ char: ' ', syl: index, pos: 0 })
      for (let i = 0; i < syl.text.length; i++) {
        const width = context.measureText(syl.text[i]).width
        if (width > charWidth) charWidth = width
        slots.push({ char: syl.text[i], syl: index, pos: i })
      }
    })
    return { slots, charWidth, sylStartSlot, font: context.font }
  }, [])

  const drawSplitBar = useCallback(() => {
    const canvas = splitCanvasRef.current
    const kara = karaRef.current
    if (!canvas || !kara) return
    const ratio = window.devicePixelRatio || 1
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // 拆分条位于 chrome 面板上：底色/文字随主题（源码为窗口底色 + 窗口文字色）
    const { bg, text } = SPLIT_BAR_PALETTES[theme]
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    const { slots, charWidth, sylStartSlot, font } = buildLayout()
    ctx.font = font
    ctx.fillStyle = text
    ctx.textBaseline = 'middle'
    slots.forEach((slot, index) => {
      const x = index * charWidth + (charWidth - ctx.measureText(slot.char).width) / 2
      ctx.fillText(slot.char, x, h / 2)
    })
    // 音节分隔线画在下一音节前导空格槽中心（syl_lines 语义）
    ctx.strokeStyle = '#3399ff'
    ctx.lineWidth = 1
    for (let i = 1; i < sylStartSlot.length; i++) {
      const x = sylStartSlot[i] * charWidth + charWidth / 2
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    // 悬停指示线：将删除分割点 → 红
    if (mouseRef.current) {
      ctx.strokeStyle = mouseRef.current.remove ? '#ff0000' : '#3399ff'
      ctx.beginPath()
      ctx.moveTo(mouseRef.current.x, 0)
      ctx.lineTo(mouseRef.current.x, h)
      ctx.stroke()
    }
  }, [buildLayout, theme])

  useEffect(() => {
    drawSplitBar()
    const canvas = splitCanvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(drawSplitBar)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [drawSplitBar, splitsPending])

  const splitPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = splitCanvasRef.current
    const kara = karaRef.current
    if (!canvas || !kara) return null
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const { slots, charWidth, sylStartSlot } = buildLayout()
    // 最近字符槽（像素取整），clamp 到 [0, slots]
    const slotIndex = Math.max(
      0,
      Math.min(slots.length, Math.floor((x + charWidth / 2) / charWidth)),
    )
    let syl = 0
    for (let i = 0; i < sylStartSlot.length; i++) if (sylStartSlot[i] <= slotIndex) syl = i
    const leftLine = syl > 0 ? sylStartSlot[syl] * charWidth + charWidth / 2 : null
    const rightLine =
      syl < sylStartSlot.length - 1 ? sylStartSlot[syl + 1] * charWidth + charWidth / 2 : null
    const remove =
      (leftLine !== null && x <= leftLine + SEPARATOR_TOLERANCE) ||
      (rightLine !== null && x >= rightLine - SEPARATOR_TOLERANCE)
    return { x, syl, slotIndex, slots, remove }
  }

  const onSplitHover = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const info = splitPointer(event)
    if (!info) return
    mouseRef.current = { x: info.x, remove: info.remove }
    drawSplitBar()
  }

  const onSplitLeave = () => {
    mouseRef.current = null
    drawSplitBar()
  }

  const onSplitClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const info = splitPointer(event)
    const kara = karaRef.current
    if (!info || !kara) return
    if (info.remove) {
      // 点在右侧线 → 删 syl+1；左侧线 → 删 syl
      let target = info.syl
      if (kara.syllables.length > 1) {
        const { charWidth, sylStartSlot } = buildLayout()
        const leftLine =
          info.syl > 0 ? sylStartSlot[info.syl] * charWidth + charWidth / 2 : Infinity
        const rightLine =
          info.syl < sylStartSlot.length - 1
            ? sylStartSlot[info.syl + 1] * charWidth + charWidth / 2
            : Infinity
        const nearerRight = Math.abs(info.x - rightLine) < Math.abs(info.x - leftLine)
        target = nearerRight ? info.syl + 1 : info.syl
        if (target >= kara.syllables.length) target = info.syl
      }
      kara.removeSplit(target)
    } else {
      const slot = info.slots[Math.min(info.slotIndex, info.slots.length - 1)]
      kara.addSplit(info.syl, slot ? slot.pos : (kara.syllables[info.syl]?.text.length ?? 0))
    }
    markSplits()
    drawSplitBar()
  }

  const setTagType = (tag: KaraokeTagType) => {
    setTagMenu(null)
    const kara = karaRef.current
    if (!kara) return
    kara.setTagType(tag)
    setTagTypeState(tag)
    onPatchText(kara.getText(), 'karaoke split')
    setSplitsPending(false)
  }

  // ---- 音节时间条绘制与拖拽 ----
  const drawTiming = useCallback(() => {
    const canvas = timingCanvasRef.current
    const kara = karaRef.current
    if (!canvas || !kara) return
    const ratio = window.devicePixelRatio || 1
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = '#0e1620'
    ctx.fillRect(0, 0, w, h)

    const start = cue.startMs
    const end = Math.max(
      kara.syllables.reduce((m, syl) => Math.max(m, syl.startMs + syl.durationMs), 0),
      cue.endMs,
    )
    const toX = (ms: number) => ((ms - start) / Math.max(1, end - start)) * w

    // 当前音节高亮
    const index = kara.syllables.findIndex(
      (syl) => currentTimeMs >= syl.startMs && currentTimeMs < syl.startMs + syl.durationMs,
    )
    if (index >= 0) {
      const syl = kara.syllables[index]
      ctx.fillStyle = 'rgba(255,255,0,0.12)'
      ctx.fillRect(toX(syl.startMs), 0, toX(syl.startMs + syl.durationMs) - toX(syl.startMs), h)
    }

    // 音节标签（粗体白字）
    ctx.font = "bold 11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif"
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    kara.syllables.forEach((syl) => {
      const x1 = toX(syl.startMs)
      const x2 = toX(syl.startMs + syl.durationMs)
      if (x2 - x1 > 8) {
        const text = syl.text || '?'
        const width = ctx.measureText(text).width
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1, 0, x2 - x1, h)
        ctx.clip()
        ctx.fillText(text, Math.max(2, (x1 + x2 - width) / 2), h / 2)
        ctx.restore()
      }
    })

    // 行首红 / 行尾蓝（不可拖），音节边界黄（可拖）
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgb(216,0,0)'
    ctx.beginPath()
    ctx.moveTo(toX(start) + 1, 0)
    ctx.lineTo(toX(start) + 1, h)
    ctx.stroke()
    ctx.strokeStyle = 'rgb(0,0,216)'
    ctx.beginPath()
    ctx.moveTo(w - 1, 0)
    ctx.lineTo(w - 1, h)
    ctx.stroke()
    ctx.strokeStyle = 'rgb(255,255,0)'
    for (let i = 1; i < kara.syllables.length; i++) {
      const x = toX(kara.syllables[i].startMs)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
  }, [cue.startMs, cue.endMs, currentTimeMs])

  useEffect(() => {
    drawTiming()
    const canvas = timingCanvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(drawTiming)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [drawTiming, timingPending, splitsPending])

  const timingPointerToMarker = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ): { marker: number; x: number } | null => {
    const canvas = timingCanvasRef.current
    const kara = karaRef.current
    if (!canvas || !kara) return null
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const w = Math.max(1, canvas.clientWidth)
    const start = cue.startMs
    const end = Math.max(
      kara.syllables.reduce((m, syl) => Math.max(m, syl.startMs + syl.durationMs), 0),
      cue.endMs,
    )
    const ms = start + (x / w) * (end - start)
    const msPerPx = (end - start) / w
    const sensitivity = DRAG_SENSITIVITY_PX * msPerPx
    // lower_bound 后取更近侧的内部边界（i >= 1）
    let best = -1
    let bestDistance = Infinity
    for (let i = 1; i < kara.syllables.length; i++) {
      const distance = Math.abs(kara.syllables[i].startMs - ms)
      if (distance <= sensitivity && distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    return best >= 0 ? { marker: best, x } : null
  }

  const onTimingDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = timingPointerToMarker(event)
    if (!hit) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { marker: hit.marker }
  }

  const onTimingMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const kara = karaRef.current
    const canvas = timingCanvasRef.current
    if (!drag || !kara || !canvas) return
    const bounds = canvas.getBoundingClientRect()
    const w = Math.max(1, canvas.clientWidth)
    const start = cue.startMs
    const end = Math.max(
      kara.syllables.reduce((m, syl) => Math.max(m, syl.startMs + syl.durationMs), 0),
      cue.endMs,
    )
    let ms = start + ((event.clientX - bounds.left) / w) * (end - start)
    // clamp 在相邻边界之间（不许交叉/重排）
    const prev = kara.syllables[drag.marker - 1].startMs
    const next =
      drag.marker + 1 < kara.syllables.length ? kara.syllables[drag.marker + 1].startMs : end
    ms = roundCs(Math.max(prev + 10, Math.min(next - 10, ms)))
    if (event.ctrlKey) {
      // Ctrl：该边界及以后整体平移
      const delta = ms - kara.syllables[drag.marker].startMs
      for (let i = drag.marker; i < kara.syllables.length; i++) {
        kara.syllables[i].startMs += delta
      }
    } else {
      kara.setStartTime(drag.marker, ms)
    }
    setTimingPending(true)
    reportPending(true)
    drawTiming()
  }

  const onTimingUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    if (autoCommit && karaRef.current) {
      onPatchText(karaRef.current.getText(), 'karaoke timing')
      setTimingPending(false)
      reportPending(false)
    }
  }

  useEffect(() => {
    if (!tagMenu) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.grid-context-menu')) setTagMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [tagMenu])

  return (
    <div className="karaoke-bar" aria-label={tPlain('Karaoke timing')}>
      <div className="karaoke-toprow">
        <button
          className="karaoke-btn"
          onClick={cancelSplits}
          disabled={!splitsPending}
          title={tPlain('Discard all uncommitted splits')}
          aria-label={tPlain('Discard all uncommitted splits')}
        >
          <X size={14} />
        </button>
        <button
          className="karaoke-btn"
          onClick={commitSplits}
          disabled={!splitsPending}
          title={tPlain('Commit splits')}
          aria-label={tPlain('Commit splits')}
        >
          <Check size={14} />
        </button>
        <canvas
          ref={splitCanvasRef}
          className="karaoke-split"
          style={{ height: SPLIT_HEIGHT }}
          onPointerMove={onSplitHover}
          onPointerLeave={onSplitLeave}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            onSplitClick(event)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setTagMenu({ x: event.clientX, y: event.clientY })
          }}
          aria-label={tPlain('Karaoke syllable splits')}
        />
      </div>
      <canvas
        ref={timingCanvasRef}
        className="karaoke-timing"
        style={{ height: TIMING_HEIGHT }}
        onPointerDown={onTimingDown}
        onPointerMove={onTimingMove}
        onPointerUp={onTimingUp}
        onPointerCancel={onTimingUp}
        data-shortcut-context="Audio"
        aria-label={tPlain('Karaoke syllable timing')}
      />
      {!autoCommit && timingPending && (
        <span className="karaoke-pending">{tPlain('Uncommitted — press Commit (Enter/G)')}</span>
      )}
      {tagMenu && (
        <MenuPopup x={tagMenu.x} y={tagMenu.y} label={tPlain('Karaoke tag')}>
          {(['\\k', '\\kf', '\\ko'] as const).map((tag) => (
            <button
              className="menu-item"
              role="menuitemcheckbox"
              aria-checked={tagType === tag}
              key={tag}
              onClick={() => setTagType(tag)}
            >
              <span className="menu-check">{tagType === tag ? '✓' : ''}</span>
              <span className="menu-label">{tag}</span>
            </button>
          ))}
        </MenuPopup>
      )}
    </div>
  )
})
