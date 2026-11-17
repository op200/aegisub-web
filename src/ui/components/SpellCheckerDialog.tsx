import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { getOptionBool, setOption } from '../../config/options'
import {
  addWordToDictionary,
  canAddWord,
  canRemoveWord,
  getSpellcheckVersion,
  getSpellCheckerLanguage,
  getSpellCheckerLanguages,
  isSpellCheckerLoaded,
  removeWordFromDictionary,
  setSpellCheckerLanguage,
  spellCheckWord,
  spellSuggestions,
  subscribeSpellcheck,
} from '../../core/spellcheck'
import type { CoreCommand, SubtitleCue } from '../../core/types'
import { editCursorState } from '../commandRegistry'
import { dialogueWords } from '../dialogueWords'
import { tPlain } from '../i18n'
import { Dialog } from './dialogs'

interface SpellCheckerDialogProps {
  cues: SubtitleCue[]
  activeId: string | null
  /** 选中活动行并选中 word 区间（SetSelectionAndActive / SetSelection） */
  onReveal: (cueId: string, start: number, end: number) => void
  onApply: (commands: CoreCommand[], label: string) => void
  onClose: () => void
}

interface CurrentWord {
  cueId: string
  start: number
  end: number
  word: string
}

/** dialog_spellchecker.cpp 的 web 移植 */
export function SpellCheckerDialog({
  cues,
  activeId,
  onReveal,
  onApply,
  onClose,
}: SpellCheckerDialogProps) {
  const spellcheckVersion = useSyncExternalStore(
    subscribeSpellcheck,
    getSpellcheckVersion,
    getSpellcheckVersion,
  )
  const [languages, setLanguages] = useState(() => getSpellCheckerLanguages())
  const [current, setCurrent] = useState<CurrentWord | null>(null)
  const [origWord, setOrigWord] = useState('')
  const [replaceWord, setReplaceWord] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [skipCommentsChecked, setSkipCommentsChecked] = useState(() =>
    getOptionBool('Tool/Spell Checker/Skip Comments'),
  )
  const [skipUppercaseChecked, setSkipUppercaseChecked] = useState(() =>
    getOptionBool('Tool/Spell Checker/Skip Uppercase'),
  )

  const autoIgnore = useRef(new Set<string>())
  const autoReplace = useRef(new Map<string, string>())
  const workingTexts = useRef(new Map<string, string>())
  const startLineId = useRef<string | null>(activeId)
  const currentLineId = useRef<string | null>(activeId)
  const hasLooped = useRef(false)
  const checkStart = useRef(editCursorState.selectionEnd)
  const initialized = useRef(false)

  if (!initialized.current) {
    initialized.current = true
    startLineId.current = activeId
    currentLineId.current = activeId
    checkStart.current = editCursorState.selectionEnd
  }

  const latestCues = useRef(cues)
  latestCues.current = cues

  const textOf = (cue: SubtitleCue): string => {
    const cached = workingTexts.current.get(cue.id)
    if (cached !== undefined) return cached
    workingTexts.current.set(cue.id, cue.text)
    return cue.text
  }

  const setTextOf = (cue: SubtitleCue, text: string) => {
    workingTexts.current.set(cue.id, text)
  }

  const setWord = (cue: SubtitleCue, start: number, end: number, word: string) => {
    const sugs = spellSuggestions(word)
    setCurrent({ cueId: cue.id, start, end, word })
    setOrigWord(word)
    setReplaceWord(sugs[0] ?? word)
    setSuggestions(sugs)
    currentLineId.current = cue.id
    checkStart.current = end
    onReveal(cue.id, start, end)
  }

  /** CheckLine：在当前行从 start_pos 起找下一个错词（自动替换的词直接写入） */
  const checkLine = (cue: SubtitleCue, startPos: number): boolean => {
    if (cue.comment && skipCommentsChecked) return false
    let text = textOf(cue)
    const ignoreUppercase = skipUppercaseChecked
    const pending: CoreCommand[] = []
    let pos = startPos

    for (;;) {
      const word = dialogueWords(text).find((item) => item.start >= pos)
      if (!word) break
      const value = word.word
      if (
        autoIgnore.current.has(value) ||
        spellCheckWord(value) ||
        (ignoreUppercase && value === value.toUpperCase())
      ) {
        pos = word.end
        continue
      }
      const replacement = autoReplace.current.get(value)
      if (replacement !== undefined) {
        text = text.slice(0, word.start) + replacement + text.slice(word.end)
        setTextOf(cue, text)
        pending.push({ type: 'updateCue', id: cue.id, patch: { text } })
        pos = word.start + replacement.length
        continue
      }
      if (pending.length) onApply(pending, 'spell check replace')
      setWord(cue, word.start, word.end, value)
      return true
    }
    if (pending.length) onApply(pending, 'spell check replace')
    return false
  }

  /** FindNext：CheckLine(start_line, current pos) → 逐行 → 绕回 start_line 再查一次 */
  const findNext = (): boolean => {
    const list = latestCues.current
    if (!list.length) return false
    const active = activeId ?? list[0].id
    // 用户切换了活动行：从该行重新开始
    if (active !== currentLineId.current) {
      currentLineId.current = active
      startLineId.current = active
      hasLooped.current = false
      checkStart.current = editCursorState.selectionEnd
    }
    let index = list.findIndex((cue) => cue.id === currentLineId.current)
    if (index < 0) index = 0
    const startId = startLineId.current

    if (checkLine(list[index], checkStart.current)) return true

    while (!hasLooped.current || list[index].id !== startId) {
      index = (index + 1) % list.length
      if (index === 0) hasLooped.current = true
      currentLineId.current = list[index].id
      if (checkLine(list[index], 0)) return true
    }

    setCurrent(null)
    setNotice(
      started
        ? tPlain('Aegisub has finished checking spelling of this script.')
        : tPlain('Aegisub has found no spelling mistakes in this script.'),
    )
    return false
  }

  const findNextRef = useRef(findNext)
  findNextRef.current = findNext

  // 词库加载/增删词后刷新语言列表与当前词的建议
  useEffect(() => {
    setLanguages(getSpellCheckerLanguages())
    if (current) setSuggestions(spellSuggestions(current.word))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在词库版本变化时同步
  }, [spellcheckVersion])

  // 词库加载完成后自动开始（构造函数的 if (FindNext()) Show()）
  useEffect(() => {
    if (started || !languages.length || !cues.length || !isSpellCheckerLoaded()) return
    setStarted(true)
    findNextRef.current()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在词库就绪时首次运行
  }, [languages.length, cues.length, started, spellcheckVersion])

  const replace = () => {
    if (!current) return
    const cue = latestCues.current.find((item) => item.id === current.cueId)
    if (!cue) return
    const text = textOf(cue)
    // 用户若在其他地方改了文本，位置的词已不是原词则跳过（源码同）
    if (text.slice(current.start, current.end) !== origWord) return
    const next = text.slice(0, current.start) + replaceWord + text.slice(current.end)
    setTextOf(cue, next)
    onApply([{ type: 'updateCue', id: cue.id, patch: { text: next } }], 'spell check replace')
    checkStart.current = current.start + replaceWord.length
  }

  const onReplace = () => {
    replace()
    findNextRef.current()
  }

  if (!started && !languages.length) {
    return (
      <Dialog
        title={tPlain('Spell Checker')}
        onClose={onClose}
        footer={<button onClick={onClose}>{tPlain('Close')}</button>}
      >
        <p className="spellcheck-error">{tPlain('No spellchecker dictionaries available.')}</p>
        <p className="spellcheck-hint">
          {tPlain(
            'Place Hunspell dictionaries (<language>.aff and <language>.dic) in the ?dictionary directory (dictionaries/).',
          )}
        </p>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={tPlain('Spell Checker')}
      onClose={onClose}
      className="spellcheck-dialog"
      footer={<button onClick={onClose}>{tPlain('Cancel')}</button>}
    >
      {notice ? (
        <div className="spellcheck-notice">
          <p>{notice}</p>
          <button onClick={onClose}>{tPlain('OK')}</button>
        </div>
      ) : (
        <div className="spellcheck-body">
          <div className="spellcheck-main">
            <label className="spellcheck-field">
              <span>{tPlain('Misspelled word:')}</span>
              <input value={origWord} readOnly />
            </label>
            <label className="spellcheck-field">
              <span>{tPlain('Replace with:')}</span>
              <input
                value={replaceWord}
                onChange={(event) => setReplaceWord(event.target.value)}
                autoFocus
              />
            </label>
            <div className="spellcheck-lists">
              <select
                className="spellcheck-suggestions"
                size={7}
                value={suggestions.includes(replaceWord) ? replaceWord : ''}
                onChange={(event) => setReplaceWord(event.target.value)}
              >
                {suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion}>
                    {suggestion}
                  </option>
                ))}
              </select>
              <select
                className="spellcheck-language"
                value={getSpellCheckerLanguage()}
                onChange={(event) => {
                  void setSpellCheckerLanguage(event.target.value).then(() => {
                    workingTexts.current.clear()
                    findNextRef.current()
                  })
                }}
              >
                {languages.map((language) => (
                  <option key={language} value={language}>
                    {language}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="spellcheck-actions">
            <label className="spellcheck-check">
              <input
                type="checkbox"
                checked={skipCommentsChecked}
                onChange={(event) => {
                  setSkipCommentsChecked(event.target.checked)
                  setOption('Tool/Spell Checker/Skip Comments', event.target.checked)
                }}
              />
              {tPlain('Skip Comments')}
            </label>
            <label className="spellcheck-check">
              <input
                type="checkbox"
                checked={skipUppercaseChecked}
                onChange={(event) => {
                  setSkipUppercaseChecked(event.target.checked)
                  setOption('Tool/Spell Checker/Skip Uppercase', event.target.checked)
                }}
              />
              {tPlain('Ignore UPPERCASE words')}
            </label>
            <button disabled={!current} onClick={onReplace}>
              {tPlain('Replace')}
            </button>
            <button
              disabled={!current}
              onClick={() => {
                if (!current) return
                autoReplace.current.set(origWord, replaceWord)
                replace()
                findNextRef.current()
              }}
            >
              {tPlain('Replace all')}
            </button>
            <button disabled={!current} onClick={() => findNextRef.current()}>
              {tPlain('Ignore')}
            </button>
            <button
              disabled={!current}
              onClick={() => {
                if (!current) return
                autoIgnore.current.add(origWord)
                findNextRef.current()
              }}
            >
              {tPlain('Ignore all')}
            </button>
            <button
              disabled={!current || !canAddWord(origWord)}
              onClick={() => {
                if (!current) return
                void addWordToDictionary(origWord).then(() => findNextRef.current())
              }}
            >
              {tPlain('Add to dictionary')}
            </button>
            <button
              disabled={!canRemoveWord(replaceWord)}
              onClick={() => {
                if (!current) return
                void removeWordFromDictionary(replaceWord).then(() => {
                  const cue = latestCues.current.find((item) => item.id === current.cueId)
                  if (cue) setWord(cue, current.start, current.end, origWord)
                })
              }}
            >
              {tPlain('Remove from dictionary')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
