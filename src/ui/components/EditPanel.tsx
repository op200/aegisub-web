import { useEffect, useRef, useState } from 'react';
import type { SubtitleCue, SubtitleStyle } from '../../core/types';
import { formatEditorTime, parseEditorTime } from '../../core/time';
import { ASS_SYNTAX_COLORS, tokenizeAss } from '../assHighlight';
import { aegisubIconUrl } from '../aegisubIcons';

const EDIT_ICON = (name: string) => aegisubIconUrl(name, 16);

function longestVisibleLine(text: string) {
  const visibleText = text.replace(/\{[^}]*\}/g, '');
  const lines = visibleText.split(/\\[Nn]|\r?\n/);
  return Math.max(0, ...lines.map((line) => Array.from(line.replace(/[\p{P}\p{Z}\s]/gu, '')).length));
}

function stripPlainText(text: string) {
  return [...text.matchAll(/\{[^}]*\}/g)].map(([block]) => block).join('');
}

interface EditPanelProps {
  cue: SubtitleCue | null;
  styles: SubtitleStyle[];
  onCommit: (patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void;
  onCommand: (id: string) => void;
  onInsertLine: () => void;
}

export function EditPanel({ cue, styles, onCommit, onCommand, onInsertLine }: EditPanelProps) {
  const [draft, setDraft] = useState<SubtitleCue | null>(cue ? structuredClone(cue) : null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalText, setOriginalText] = useState(cue?.text ?? '');
  const originalCueIdRef = useRef(cue?.id);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  useEffect(() => setDraft(cue ? structuredClone(cue) : null), [cue]);
  useEffect(() => {
    if (cue?.id !== originalCueIdRef.current) {
      originalCueIdRef.current = cue?.id;
      setOriginalText(cue?.text ?? '');
    }
  }, [cue]);
  if (!cue || !draft) return <section className="edit-panel empty-edit">No line selected</section>;

  const commit = (field: keyof SubtitleCue, value: SubtitleCue[keyof SubtitleCue], label: string) => {
    if (cue[field] !== value) onCommit({ [field]: value }, label);
  };
  const setTime = (field: 'startMs' | 'endMs', text: string) => {
    const value = parseEditorTime(text);
    if (value !== null) {
      setDraft((current) => (current ? { ...current, [field]: value } : current));
      commit(field, value, `Set ${field === 'startMs' ? 'start' : 'end'} time`);
    } else setDraft(cue ? structuredClone(cue) : null);
  };
  const wrapSelection = (open: string, close = open) => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextText = `${draft.text.slice(0, editor.selectionStart)}${open}${draft.text.slice(editor.selectionStart, editor.selectionEnd)}${close}${draft.text.slice(editor.selectionEnd)}`;
    setDraft({ ...draft, text: nextText });
    onCommit({ text: nextText }, 'Edit text');
    requestAnimationFrame(() => editor.focus());
  };
  const syncScroll = () => {
    if (highlightRef.current && editorRef.current) {
      highlightRef.current.scrollTop = editorRef.current.scrollTop;
      highlightRef.current.scrollLeft = editorRef.current.scrollLeft;
    }
  };
  const commitText = (text: string, label: string) => {
    setDraft({ ...draft, text });
    onCommit({ text }, label);
    requestAnimationFrame(() => editorRef.current?.focus());
  };
  const highlighted = tokenizeAss(draft.text);
  const characterCount = longestVisibleLine(draft.text);

  return (
    <section className="edit-panel" aria-label="Line editor">
      {/* 第 1 行：Comment | Style | Edit | Actor | Effect | 字符数（Aegisub top_sizer） */}
      <div className="edit-row edit-row-top">
        <label className="comment-toggle">
          <input
            type="checkbox"
            checked={draft.comment}
            onChange={(event) => {
              setDraft({ ...draft, comment: event.target.checked });
              commit('comment', event.target.checked, 'Toggle comment');
            }}
          />
          Comment
        </label>
        <label className="edit-style">
          <select
            value={draft.style}
            onChange={(event) => {
              setDraft({ ...draft, style: event.target.value });
              commit('style', event.target.value, 'Set style');
            }}
          >
            {styles.map((style) => (
              <option key={style.id}>{style.name}</option>
            ))}
          </select>
        </label>
        <button className="edit-edit-btn" onClick={() => onCommand('tool/style/manager')} title="Edit style">
          Edit
        </button>
        <label className="edit-actor">
          <input
            list={`edit-actor-values-${cue.id}`}
            placeholder="Actor"
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            onBlur={() => commit('actor', draft.actor, 'Set actor')}
          />
          <datalist id={`edit-actor-values-${cue.id}`}>{cue.actor && <option value={cue.actor} />}</datalist>
        </label>
        <label className="edit-effect">
          <input
            list={`edit-effect-values-${cue.id}`}
            placeholder="Effect"
            value={draft.effect}
            onChange={(event) => setDraft({ ...draft, effect: event.target.value })}
            onBlur={() => commit('effect', draft.effect, 'Set effect')}
          />
          <datalist id={`edit-effect-values-${cue.id}`}>{cue.effect && <option value={cue.effect} />}</datalist>
        </label>
        <output
          className={`char-count${characterCount > 40 ? ' over-limit' : ''}`}
          title="Number of characters in the longest line of this subtitle"
        >
          {characterCount}
        </output>
      </div>

      {/* Aegisub middle_left_sizer；足够宽时会把 middle_right_sizer 接到本行末尾。 */}
      <div className="edit-middle">
        <div className="edit-row edit-row-times">
          <input
            className="layer-field"
            aria-label="Layer"
            title="Layer number"
            type="number"
            min={0}
            max={999}
            value={draft.layer}
            onChange={(event) => setDraft({ ...draft, layer: Number(event.target.value) })}
            onBlur={() => commit('layer', draft.layer, 'Set layer')}
          />
          <input
            className="time-field"
            aria-label="Start"
            title="Start time"
            value={formatEditorTime(draft.startMs)}
            onChange={(event) => {
              const parsed = parseEditorTime(event.target.value);
              if (parsed !== null) setDraft({ ...draft, startMs: parsed });
            }}
            onBlur={(event) => setTime('startMs', event.target.value)}
          />
          <input
            className="time-field"
            aria-label="End"
            title="End time"
            value={formatEditorTime(draft.endMs)}
            onChange={(event) => {
              const parsed = parseEditorTime(event.target.value);
              if (parsed !== null) setDraft({ ...draft, endMs: parsed });
            }}
            onBlur={(event) => setTime('endMs', event.target.value)}
          />
          <input
            className="time-field duration-field"
            aria-label="Duration"
            title="Line duration"
            value={formatEditorTime(Math.max(0, draft.endMs - draft.startMs))}
            onChange={(event) => {
              const parsed = parseEditorTime(event.target.value);
              if (parsed !== null) {
                const endMs = draft.startMs + parsed;
                setDraft({ ...draft, endMs });
                commit('endMs', endMs, 'Set duration');
              }
            }}
            onBlur={(event) => {
              const parsed = parseEditorTime(event.target.value);
              if (parsed !== null) {
                const endMs = draft.startMs + parsed;
                setDraft({ ...draft, endMs });
                commit('endMs', endMs, 'Set duration');
              }
            }}
          />
          <input
            className="margin-field"
            aria-label="Left margin"
            title="Left Margin (0 = default from style)"
            type="number"
            value={draft.marginL}
            onChange={(event) => setDraft({ ...draft, marginL: Number(event.target.value) })}
            onBlur={() => commit('marginL', draft.marginL, 'Set left margin')}
          />
          <input
            className="margin-field"
            aria-label="Right margin"
            title="Right Margin (0 = default from style)"
            type="number"
            value={draft.marginR}
            onChange={(event) => setDraft({ ...draft, marginR: Number(event.target.value) })}
            onBlur={() => commit('marginR', draft.marginR, 'Set right margin')}
          />
          <input
            className="margin-field"
            aria-label="Vertical margin"
            title="Vertical Margin (0 = default from style)"
            type="number"
            value={draft.marginV}
            onChange={(event) => setDraft({ ...draft, marginV: Number(event.target.value) })}
            onBlur={() => commit('marginV', draft.marginV, 'Set vertical margin')}
          />
        </div>

        <div className="edit-row edit-row-format" aria-label="Text formatting tools">
          <button onClick={() => wrapSelection('{\\b1}', '{\\b0}')} title="Bold" aria-label="Bold">
            <img src={EDIT_ICON('button_bold')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => wrapSelection('{\\i1}', '{\\i0}')} title="Italic" aria-label="Italic">
            <img src={EDIT_ICON('button_italics')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => wrapSelection('{\\u1}', '{\\u0}')} title="Underline" aria-label="Underline">
            <img src={EDIT_ICON('button_underline')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => wrapSelection('{\\s1}', '{\\s0}')} title="Strikeout" aria-label="Strikeout">
            <img src={EDIT_ICON('button_strikeout')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => onCommand('tool/style/manager')} title="Font" aria-label="Font">
            <img src={EDIT_ICON('button_fontname')} alt="" width={16} height={16} draggable={false} />
          </button>
          <span className="edit-toolbar-spacer" />
          <button onClick={() => wrapSelection('{\\c&H00FFFFFF&}')} title="Primary color" aria-label="Primary color">
            <img src={EDIT_ICON('button_color_one')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button
            onClick={() => wrapSelection('{\\2c&H00FFFFFF&}')}
            title="Secondary color"
            aria-label="Secondary color"
          >
            <img src={EDIT_ICON('button_color_two')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => wrapSelection('{\\3c&H00000000&}')} title="Outline color" aria-label="Outline color">
            <img src={EDIT_ICON('button_color_three')} alt="" width={16} height={16} draggable={false} />
          </button>
          <button onClick={() => wrapSelection('{\\4c&H00000000&}')} title="Shadow color" aria-label="Shadow color">
            <img src={EDIT_ICON('button_color_four')} alt="" width={16} height={16} draggable={false} />
          </button>
          <span className="edit-toolbar-spacer" />
          <button
            onClick={onInsertLine}
            title="Move to the next subtitle line, creating a new one if needed"
            aria-label="Next line"
          >
            <img src={EDIT_ICON('button_audio_commit')} alt="" width={16} height={16} draggable={false} />
          </button>
          <span className="edit-time-mode" role="radiogroup" aria-label="Time display mode">
            <label>
              <input type="radio" name="edit-time-mode" checked readOnly /> Time
            </label>
            <label>
              <input type="radio" name="edit-time-mode" disabled /> Frame
            </label>
          </span>
          <label className="show-original">
            <input type="checkbox" checked={showOriginal} onChange={(event) => setShowOriginal(event.target.checked)} />{' '}
            Show Original
          </label>
        </div>
      </div>

      {showOriginal && (
        <textarea className="cue-editor-original" readOnly value={originalText} aria-label="Original text" />
      )}
      <div className="cue-editor-wrap">
        <pre ref={highlightRef} className="cue-editor-highlight" aria-hidden="true">
          {highlighted.map((segment, index) => {
            const style = ASS_SYNTAX_COLORS[segment.type];
            return (
              <span key={index} style={{ color: style.color, fontWeight: style.bold ? 700 : 400 }}>
                {segment.text}
              </span>
            );
          })}
        </pre>
        <textarea
          ref={editorRef}
          className="cue-editor"
          data-shortcut-context="Subtitle Edit Box"
          aria-label="Subtitle text"
          value={draft.text}
          spellCheck
          onChange={(event) => {
            setDraft({ ...draft, text: event.target.value });
            onCommit({ text: event.target.value }, 'Edit text');
          }}
          onScroll={syncScroll}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              event.stopPropagation();
              const editor = event.currentTarget;
              const nextText = `${draft.text.slice(0, editor.selectionStart)}\\N${draft.text.slice(editor.selectionEnd)}`;
              const nextPosition = editor.selectionStart + 2;
              setDraft({ ...draft, text: nextText });
              onCommit({ text: nextText }, 'Edit text');
              requestAnimationFrame(() => editor.setSelectionRange(nextPosition, nextPosition));
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              event.stopPropagation();
              onCommit({ text: draft.text }, 'Edit text');
              onCommand('grid/line/next/create');
            } else if (event.key === 'Tab') {
              event.preventDefault();
              const focusable = Array.from(
                document.querySelectorAll<HTMLElement>(
                  'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
                ),
              ).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
              const index = focusable.indexOf(event.currentTarget);
              const nextIndex = Math.max(0, Math.min(focusable.length - 1, index + (event.shiftKey ? -1 : 1)));
              focusable[nextIndex]?.focus();
            }
          }}
        />
      </div>
      {showOriginal && (
        <div className="edit-bottom-actions">
          <button onClick={() => commitText(originalText, 'Revert line')}>Revert</button>
          <button onClick={() => commitText('', 'Clear line')}>Clear</button>
          <button onClick={() => commitText(stripPlainText(draft.text), 'Clear line text')}>Clear Text</button>
          <button
            onClick={() => {
              const editor = editorRef.current;
              const start = editor?.selectionStart ?? draft.text.length;
              const end = editor?.selectionEnd ?? start;
              commitText(`${draft.text.slice(0, start)}${originalText}${draft.text.slice(end)}`, 'Insert original');
            }}
          >
            Insert Original
          </button>
        </div>
      )}
    </section>
  );
}
