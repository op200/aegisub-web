/**
 * 汉字K值配对器（dialog_kara_timing_copy.cpp 的 web 移植）。
 *
 * 匹配算法在 core/karaokeMatcher.ts；本组件只负责源码 DialogKanjiTimer 的
 * 状态机、键盘交互、显示与关闭时提交。
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { getOptionBool, setOption } from '../../config/options'
import { strippedText } from '../../core/dialogueBlocks'
import { parseKaraokeSyllables, type KaraokeSyllable } from '../../core/karaoke'
import { KaraokeMatcher, type KaraokeMatchGroup } from '../../core/karaokeMatcher'
import type { CoreCommand, SubtitleCue } from '../../core/types'
import { tPlain } from '../i18n'
import { Dialog } from './dialogs'

const INTERPOLATION_OPTION = 'Tool/Kanji Timer/Interpolation'

const SHORTCUT_HELP = tPlain(
  'When the destination textbox has focus, use the following keys:\n\nRight Arrow: Increase dest. selection length\nLeft Arrow: Decrease dest. selection length\nUp Arrow: Increase source selection length\nDown Arrow: Decrease source selection length\nEnter: Link, accept line when done\nBackspace: Unlink last',
)

let bellContext: AudioContext | null = null

/** 等价于源码 wxBell()：不支持 WebAudio 时静默 */
function playBell(): void {
  if (typeof AudioContext === 'undefined') return
  try {
    bellContext ??= new AudioContext()
    const oscillator = bellContext.createOscillator()
    const gain = bellContext.createGain()
    oscillator.frequency.value = 880
    gain.gain.value = 0.04
    oscillator.connect(gain)
    gain.connect(bellContext.destination)
    oscillator.start()
    oscillator.stop(bellContext.currentTime + 0.06)
  } catch {
    // 自动播放限制或音频设备不可用时忽略
  }
}

/** find_next：从 fromIndex 之外开始，找样式匹配且原文本非空的行 */
function findNextStyleMatch(cues: SubtitleCue[], fromIndex: number, style: string): number | null {
  for (let index = fromIndex + 1; index < cues.length; index += 1) {
    const cue = cues[index]
    if (cue.style === style && cue.text !== '') return index
  }
  return null
}

/** FindPrevStyleMatch：reverse_iterator 语义，从前一行开始向前 */
function findPrevStyleMatch(cues: SubtitleCue[], fromIndex: number, style: string): number | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const cue = cues[index]
    if (cue.style === style && cue.text !== '') return index
  }
  return null
}

export interface KanjiTimerDialogProps {
  cues: SubtitleCue[]
  styles: string[]
  onClose: () => void
  onApply: (commands: CoreCommand[], label: string) => void
}

interface MatcherSnapshot {
  groups: KaraokeMatchGroup[]
  selectedSource: KaraokeSyllable[]
  unmatchedSource: KaraokeSyllable[]
  selectedDest: string
  unmatchedDest: string
}

/** 把可变的 matcher 状态拷贝为可安全渲染的快照 */
function snapshotMatcher(matcher: KaraokeMatcher): MatcherSnapshot {
  return {
    groups: matcher.matchedGroups().map((group) => ({ src: group.src, dst: group.dst })),
    selectedSource: matcher.currentSourceSelection(),
    unmatchedSource: matcher.unmatchedSource(),
    selectedDest: matcher.currentDestinationSelection(),
    unmatchedDest: matcher.unmatchedDestination(),
  }
}

export function KanjiTimerDialog({ cues, styles, onClose, onApply }: KanjiTimerDialogProps) {
  const [matcher] = useState(() => new KaraokeMatcher())
  const [snapshot, setSnapshot] = useState<MatcherSnapshot>(() => snapshotMatcher(matcher))
  const refresh = () => setSnapshot(snapshotMatcher(matcher))

  const displayRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  const [sourceStyle, setSourceStyle] = useState('')
  const [destStyle, setDestStyle] = useState('')
  const [interpolate, setInterpolate] = useState(() => getOptionBool(INTERPOLATION_OPTION))
  const [currentSourceId, setCurrentSourceId] = useState<string | null>(null)
  const [currentDestId, setCurrentDestId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; text: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [displayFocused, setDisplayFocused] = useState(false)

  // 内容超宽时滚到最右，保持当前选择/尾部可见（源码为跳过旧组 + 箭头）
  useEffect(() => {
    const pane = paneRef.current
    if (pane) pane.scrollLeft = pane.scrollWidth
  })

  const indexOf = (id: string | null): number | null => {
    if (id === null) return null
    const index = cues.findIndex((cue) => cue.id === id)
    return index >= 0 ? index : null
  }
  const idAt = (index: number | null): string | null =>
    index === null ? null : (cues[index]?.id ?? null)

  const resetForNewLine = (sourceId: string | null, destId: string | null) => {
    let nextSourceId = sourceId
    let nextDestId = destId
    if (nextSourceId === null || nextDestId === null) {
      nextSourceId = null
      nextDestId = null
      playBell()
    }

    setCurrentSourceId(nextSourceId)
    setCurrentDestId(nextDestId)

    const sourceCue = nextSourceId === null ? null : cues.find((cue) => cue.id === nextSourceId)
    const destCue = nextDestId === null ? null : cues.find((cue) => cue.id === nextDestId)
    matcher.setInputData(
      sourceCue ? parseKaraokeSyllables(sourceCue.text, sourceCue.startMs) : [],
      destCue ? strippedText(destCue.text) : '',
    )
    if (interpolate) matcher.autoMatchJapanese()

    refresh()
    displayRef.current?.focus({ preventScroll: true })
  }

  const handleStart = () => {
    setError(null)
    if (!sourceStyle || !destStyle) {
      setError(tPlain('Select source and destination styles first.'))
    } else if (sourceStyle === destStyle) {
      setError(tPlain('The source and destination styles must be different.'))
    } else {
      const first = cues.length > 0 ? cues[0] : null
      let sourceIndex = first ? 0 : null
      let destIndex = first ? 0 : null
      if (sourceIndex !== null && first && first.style !== sourceStyle) {
        sourceIndex = findNextStyleMatch(cues, sourceIndex, sourceStyle)
      }
      if (destIndex !== null && first && first.style !== destStyle) {
        destIndex = findNextStyleMatch(cues, destIndex, destStyle)
      }
      resetForNewLine(idAt(sourceIndex), idAt(destIndex))
    }
    // 源码 OnStart 无论成功失败都在末尾清空已接受的行
    setPending([])
  }

  const handleLink = () => {
    setError(null)
    if (matcher.acceptMatch()) {
      if (interpolate) matcher.autoMatchJapanese()
      refresh()
    } else {
      playBell()
    }
  }

  const handleUnlink = () => {
    setError(null)
    if (matcher.undoMatch()) {
      refresh()
    } else {
      playBell()
    }
  }

  const handleSkipSource = () => {
    setError(null)
    const index = indexOf(currentSourceId)
    const next = index === null ? null : findNextStyleMatch(cues, index, sourceStyle)
    resetForNewLine(idAt(next), currentDestId)
  }

  const handleSkipDest = () => {
    setError(null)
    const index = indexOf(currentDestId)
    const next = index === null ? null : findNextStyleMatch(cues, index, destStyle)
    resetForNewLine(currentSourceId, idAt(next))
  }

  const handleGoBack = () => {
    setError(null)
    if (pending.length > 0) setPending(pending.slice(0, -1))

    const sourceIndex = indexOf(currentSourceId)
    const destIndex = indexOf(currentDestId)
    const prevSource =
      sourceIndex === null ? null : findPrevStyleMatch(cues, sourceIndex, sourceStyle)
    const prevDest = destIndex === null ? null : findPrevStyleMatch(cues, destIndex, destStyle)
    resetForNewLine(idAt(prevSource), idAt(prevDest))
  }

  const handleAcceptLine = () => {
    setError(null)
    if (currentDestId === null) return

    if (matcher.remainingSource() > 0) {
      setError(tPlain('Group all of the source text.'))
      return
    }

    setPending([...pending, { id: currentDestId, text: matcher.getOutputLine() }])

    const sourceIndex = indexOf(currentSourceId)
    const destIndex = indexOf(currentDestId)
    const nextSource =
      sourceIndex === null ? null : findNextStyleMatch(cues, sourceIndex, sourceStyle)
    const nextDest = destIndex === null ? null : findNextStyleMatch(cues, destIndex, destStyle)
    resetForNewLine(idAt(nextSource), idAt(nextDest))
  }

  const handleClose = () => {
    setOption(INTERPOLATION_OPTION, interpolate)
    if (pending.length > 0) {
      const commands: CoreCommand[] = pending.map(({ id, text }) => ({
        type: 'updateCue',
        id,
        patch: { text },
      }))
      onApply(commands, 'kanji timing')
    }
    onClose()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') return // 由 Dialog 的 ESC 栈调用 handleClose
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button, select, input, textarea')) return

    let handled = true
    switch (event.key) {
      case 'Backspace':
        handleUnlink()
        break
      case 'ArrowRight':
        if (matcher.increaseDestinationMatch()) refresh()
        break
      case 'ArrowLeft':
        if (matcher.decreaseDestinationMatch()) refresh()
        break
      case 'ArrowUp':
        if (matcher.increaseSourceMatch()) refresh()
        break
      case 'ArrowDown':
        if (matcher.decreaseSourceMatch()) refresh()
        break
      case 'Enter':
        if (matcher.remainingSource() === 0 && matcher.remainingDestination() === 0) {
          handleAcceptLine()
        } else {
          handleLink()
        }
        break
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const { groups, selectedSource, unmatchedSource, selectedDest, unmatchedDest } = snapshot

  const renderBox = (text: string, selected: boolean, key: number) => (
    <span key={key} className={`kanji-box${selected ? ' selected' : ''}`}>
      {text}
    </span>
  )

  return (
    <Dialog
      title={tPlain('Kanji timer')}
      onClose={handleClose}
      footer={<button onClick={handleClose}>{tPlain('&Close')}</button>}
    >
      <div className="kanji-body" onKeyDown={handleKeyDown}>
        {error && <p className="dialog-error">{error}</p>}

        <fieldset className="dialog-fieldset kanji-display-box">
          <legend>{tPlain('Text')}</legend>
          <div
            ref={displayRef}
            className={`kanji-display${displayFocused ? ' focused' : ''}`}
            tabIndex={0}
            onFocus={() => setDisplayFocused(true)}
            onBlur={() => setDisplayFocused(false)}
          >
            <div className="kanji-labels">
              <span className="kanji-label">{tPlain('Source: ')}</span>
              <span className="kanji-label">{tPlain('Dest: ')}</span>
            </div>
            <div ref={paneRef} className="kanji-pane">
              {groups.map((group, groupIndex) => (
                <Fragment key={groupIndex}>
                  <div className="kanji-cell">
                    {group.src.map((syllable, index) => renderBox(syllable.text, false, index))}
                  </div>
                  <div className="kanji-cell">
                    <span className="kanji-box">{group.dst}</span>
                  </div>
                </Fragment>
              ))}
              <div className="kanji-cell kanji-tail">
                {selectedSource.map((syllable, index) => renderBox(syllable.text, true, index))}
                {unmatchedSource.map((syllable, index) => renderBox(syllable.text, false, index))}
              </div>
              <div className="kanji-cell kanji-tail">
                {selectedDest && <span className="kanji-box selected">{selectedDest}</span>}
                {unmatchedDest && <span className="kanji-box">{unmatchedDest}</span>}
              </div>
            </div>
          </div>
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={interpolate}
              onChange={(event) => setInterpolate(event.target.checked)}
            />
            {tPlain('Attempt to &interpolate kanji')}
          </label>
        </fieldset>

        <div className="kanji-bottom">
          <div className="kanji-bottom-left">
            <fieldset className="dialog-fieldset">
              <legend>{tPlain('Styles')}</legend>
              <div className="kanji-style-grid">
                <label htmlFor="kanji-source-style">{tPlain('Source: ')}</label>
                <select
                  id="kanji-source-style"
                  value={sourceStyle}
                  onChange={(event) => setSourceStyle(event.target.value)}
                >
                  <option value="" />
                  {styles.map((style) => (
                    <option key={style} value={style}>
                      {style}
                    </option>
                  ))}
                </select>
                <label htmlFor="kanji-dest-style">{tPlain('Dest: ')}</label>
                <select
                  id="kanji-dest-style"
                  value={destStyle}
                  onChange={(event) => setDestStyle(event.target.value)}
                >
                  <option value="" />
                  {styles.map((style) => (
                    <option key={style} value={style}>
                      {style}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
            <fieldset className="dialog-fieldset kanji-help">
              <legend>{tPlain('Shortcut Keys')}</legend>
              <p>{SHORTCUT_HELP}</p>
            </fieldset>
          </div>

          <fieldset className="dialog-fieldset kanji-commands">
            <legend>{tPlain('Commands')}</legend>
            <button onClick={handleStart}>{tPlain('S&tart!')}</button>
            <button onClick={handleLink}>{tPlain('&Link')}</button>
            <button onClick={handleUnlink}>{tPlain('&Unlink')}</button>
            <button onClick={handleSkipSource}>{tPlain('Skip &Source Line')}</button>
            <button onClick={handleSkipDest}>{tPlain('Skip &Dest Line')}</button>
            <button onClick={handleGoBack}>{tPlain('&Go Back a Line')}</button>
            <button onClick={handleAcceptLine}>{tPlain('&Accept Line')}</button>
          </fieldset>
        </div>
      </div>
    </Dialog>
  )
}
