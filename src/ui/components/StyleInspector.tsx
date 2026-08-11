import { Bold, Italic, Plus, Trash2, Underline } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SubtitleStyle } from '../../core/types';
import { assColorToHex, hexToAssColor } from '../color';

interface StyleInspectorProps {
  styles: SubtitleStyle[];
  activeStyleName: string;
  onUpdate: (id: string, patch: Partial<Omit<SubtitleStyle, 'id'>>) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}

export function StyleInspector({ styles, activeStyleName, onUpdate, onAdd, onDelete }: StyleInspectorProps) {
  const initial = styles.find((style) => style.name === activeStyleName) ?? styles[0];
  const [selectedId, setSelectedId] = useState(initial?.id ?? '');
  const selected = styles.find((style) => style.id === selectedId) ?? initial;
  useEffect(() => {
    if (initial) setSelectedId(initial.id);
  }, [initial]);
  if (!selected) return null;

  return (
    <aside className="style-inspector" aria-label="Style inspector">
      <div className="inspector-heading">
        <h2>Style</h2>
        <div>
          <button className="icon-button" onClick={onAdd} title="Add style" aria-label="Add style">
            <Plus size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => onDelete(selected.id)}
            disabled={styles.length <= 1}
            title="Delete style"
            aria-label="Delete style"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <label>
        Preset
        <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
          {styles.map((style) => (
            <option value={style.id} key={style.id}>
              {style.name}
            </option>
          ))}
        </select>
      </label>
      <div className="inspector-grid">
        <label>
          Name
          <input value={selected.name} onChange={(event) => onUpdate(selected.id, { name: event.target.value })} />
        </label>
        <label>
          Font
          <input
            value={selected.fontName}
            onChange={(event) => onUpdate(selected.id, { fontName: event.target.value })}
          />
        </label>
        <label>
          Size
          <input
            type="number"
            min="6"
            max="400"
            value={selected.fontSize}
            onChange={(event) => onUpdate(selected.id, { fontSize: Number(event.target.value) })}
          />
        </label>
        <label>
          Alignment
          <select
            value={selected.alignment}
            onChange={(event) => onUpdate(selected.id, { alignment: Number(event.target.value) })}
          >
            {[7, 8, 9, 4, 5, 6, 1, 2, 3].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Outline
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={selected.outline}
            onChange={(event) => onUpdate(selected.id, { outline: Number(event.target.value) })}
          />
        </label>
        <label>
          Shadow
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={selected.shadow}
            onChange={(event) => onUpdate(selected.id, { shadow: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="text-toggles" role="group" aria-label="Text style">
        <button
          className={selected.bold ? 'pressed' : ''}
          onClick={() => onUpdate(selected.id, { bold: !selected.bold })}
          title="Bold"
          aria-label="Bold"
          aria-pressed={selected.bold}
        >
          <Bold size={16} />
        </button>
        <button
          className={selected.italic ? 'pressed' : ''}
          onClick={() => onUpdate(selected.id, { italic: !selected.italic })}
          title="Italic"
          aria-label="Italic"
          aria-pressed={selected.italic}
        >
          <Italic size={16} />
        </button>
        <button
          className={selected.underline ? 'pressed' : ''}
          onClick={() => onUpdate(selected.id, { underline: !selected.underline })}
          title="Underline"
          aria-label="Underline"
          aria-pressed={selected.underline}
        >
          <Underline size={16} />
        </button>
      </div>
      <div className="color-controls">
        <label>
          <span className="color-swatch" style={{ background: assColorToHex(selected.primaryColor) }} />
          Primary
          <input
            type="color"
            value={assColorToHex(selected.primaryColor)}
            onChange={(event) =>
              onUpdate(selected.id, { primaryColor: hexToAssColor(event.target.value, selected.primaryColor) })
            }
          />
        </label>
        <label>
          <span className="color-swatch" style={{ background: assColorToHex(selected.outlineColor) }} />
          Outline
          <input
            type="color"
            value={assColorToHex(selected.outlineColor)}
            onChange={(event) =>
              onUpdate(selected.id, { outlineColor: hexToAssColor(event.target.value, selected.outlineColor) })
            }
          />
        </label>
        <label>
          <span className="color-swatch" style={{ background: assColorToHex(selected.backColor) }} />
          Shadow
          <input
            type="color"
            value={assColorToHex(selected.backColor)}
            onChange={(event) =>
              onUpdate(selected.id, { backColor: hexToAssColor(event.target.value, selected.backColor) })
            }
          />
        </label>
      </div>
    </aside>
  );
}
