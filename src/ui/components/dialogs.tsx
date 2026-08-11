import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { CoreCommand, SubtitleCue, SubtitleStyle } from '../../core/types';
import type { DummyVideoOptions, MediaSource } from '../../platform/types';
import { formatEditorTime } from '../../core/time';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Dialog({ title, onClose, children, footer }: DialogProps) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="app-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button className="dialog-close" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shift Times
// ---------------------------------------------------------------------------
export interface ShiftTimesOptions {
  byMs: boolean;
  amount: number;
  backward: boolean;
  selectedOnly: boolean;
}

interface ShiftTimesDialogProps {
  cues: SubtitleCue[];
  selectedIds: string[];
  onClose: () => void;
  onApply: (commands: CoreCommand[], label: string) => void;
}

export function ShiftTimesDialog({ cues, selectedIds, onClose, onApply }: ShiftTimesDialogProps) {
  const [byMs, setByMs] = useState(true);
  const [amount, setAmount] = useState(100);
  const [frames, setFrames] = useState(1);
  const [backward, setBackward] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);

  const apply = () => {
    const shift = byMs ? amount : frames * 10; // 近似 10ms/帧（Aegisub 默认帧率处理）
    const signed = backward ? -shift : shift;
    if (!signed) return;
    const selSet = new Set(selectedIds);
    const targets = cues.filter((cue) => !selectedOnly || selSet.has(cue.id));
    const commands: CoreCommand[] = targets.map((cue) => ({
      type: 'updateCue',
      id: cue.id,
      patch: {
        startMs: Math.max(0, cue.startMs + signed),
        endMs: Math.max(0, cue.endMs + signed),
      },
    }));
    onApply(commands, `Shift times ${backward ? 'backward' : 'forward'}`);
    onClose();
  };

  return (
    <Dialog
      title="Shift Times"
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          Preset
          <select value={byMs ? 'ms' : 'frames'} onChange={(event) => setByMs(event.target.value === 'ms')}>
            <option value="ms">Custom (milliseconds)</option>
            <option value="frames">Custom (frames)</option>
          </select>
        </label>
        {byMs ? (
          <label>
            Shift by (ms)
            <input type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} autoFocus />
          </label>
        ) : (
          <label>
            Shift by (frames)
            <input type="number" value={frames} onChange={(event) => setFrames(Number(event.target.value))} autoFocus />
          </label>
        )}
        <label>
          Direction
          <select
            value={backward ? 'back' : 'forward'}
            onChange={(event) => setBackward(event.target.value === 'back')}
          >
            <option value="forward">Forward</option>
            <option value="back">Backward</option>
          </select>
        </label>
        <label>
          Apply to
          <select
            value={selectedOnly ? 'selected' : 'all'}
            onChange={(event) => setSelectedOnly(event.target.value === 'selected')}
          >
            <option value="all">All lines</option>
            <option value="selected">Selected lines only</option>
          </select>
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Jump to
// ---------------------------------------------------------------------------
interface JumpToDialogProps {
  currentTimeMs: number;
  durationMs: number;
  onClose: () => void;
  onJump: (timeMs: number) => void;
}

export function JumpToDialog({ currentTimeMs, durationMs, onClose, onJump }: JumpToDialogProps) {
  const [value, setValue] = useState(Math.round(currentTimeMs));

  const jump = () => {
    const clamped = Math.max(0, Math.min(durationMs || value, value));
    onJump(clamped);
    onClose();
  };

  return (
    <Dialog
      title="Jump to"
      onClose={onClose}
      footer={
        <>
          <button onClick={jump}>Jump</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          Time (ms)
          <input type="number" value={value} onChange={(event) => setValue(Number(event.target.value))} autoFocus />
        </label>
        <label>
          Preview
          <input readOnly value={formatEditorTime(value)} />
        </label>
        <div className="dialog-row">
          <button type="button" onClick={() => setValue(0)}>
            Start
          </button>
          <button type="button" onClick={() => setValue(Math.max(0, durationMs))}>
            End
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Script Properties（对应 Aegisub dialog_properties.cpp）
// ---------------------------------------------------------------------------
interface ScriptPropertiesDialogProps {
  scriptInfo: Record<string, string>;
  onClose: () => void;
  onApply: (patch: Record<string, string>) => void;
}

const PROPERTY_FIELDS = [
  ['Title', 'Title'],
  ['Original Script', 'Original Script'],
  ['Original Translation', 'Original Translation'],
  ['Original Editing', 'Original Editing'],
  ['Original Timing', 'Original Timing'],
  ['Synch Point', 'Synch Point'],
  ['Script Updated By', 'Script Updated By'],
  ['Update Details', 'Update Details'],
] as const;

export function ScriptPropertiesDialog({ scriptInfo, onClose, onApply }: ScriptPropertiesDialogProps) {
  const [values, setValues] = useState(() => ({ ...scriptInfo }));
  const setValue = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const apply = () => {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if ((scriptInfo[key] ?? '') !== value) patch[key] = value;
    for (const [key] of PROPERTY_FIELDS) if (!(key in values) && scriptInfo[key]) patch[key] = '';
    if (Object.keys(patch).length) onApply(patch);
    onClose();
  };

  return (
    <Dialog
      title="Script Properties"
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="dialog-fields properties-fields">
        {PROPERTY_FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input value={values[key] ?? ''} onChange={(event) => setValue(key, event.target.value)} />
          </label>
        ))}
        <label>
          PlayResX
          <input
            type="number"
            min={1}
            value={values.PlayResX ?? ''}
            onChange={(event) => setValue('PlayResX', event.target.value)}
          />
        </label>
        <label>
          PlayResY
          <input
            type="number"
            min={1}
            value={values.PlayResY ?? ''}
            onChange={(event) => setValue('PlayResY', event.target.value)}
          />
        </label>
        <label>
          LayoutResX
          <input
            type="number"
            min={0}
            value={values.LayoutResX ?? ''}
            onChange={(event) => setValue('LayoutResX', event.target.value)}
          />
        </label>
        <label>
          LayoutResY
          <input
            type="number"
            min={0}
            value={values.LayoutResY ?? ''}
            onChange={(event) => setValue('LayoutResY', event.target.value)}
          />
        </label>
        <label>
          Wrap Style
          <select value={values.WrapStyle ?? '0'} onChange={(event) => setValue('WrapStyle', event.target.value)}>
            <option value="0">0: Smart wrapping, top line wider</option>
            <option value="1">1: End-of-line word wrapping</option>
            <option value="2">2: No word wrapping</option>
            <option value="3">3: Smart wrapping, bottom line wider</option>
          </select>
        </label>
        <label>
          YCbCr Matrix
          <select
            value={values['YCbCr Matrix'] ?? 'None'}
            onChange={(event) => setValue('YCbCr Matrix', event.target.value)}
          >
            {['None', 'TV.601', 'PC.601', 'TV.709', 'PC.709', 'TV.2020', 'PC.2020'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="dialog-checkbox-row">
          Scaled Border and Shadow
          <input
            type="checkbox"
            checked={(values.ScaledBorderAndShadow ?? 'yes').toLowerCase() === 'yes'}
            onChange={(event) => setValue('ScaledBorderAndShadow', event.target.checked ? 'yes' : 'no')}
          />
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Styling Assistant（对应 Aegisub dialog_styling_assistant.cpp 的核心工作流）
// ---------------------------------------------------------------------------
interface StylingAssistantDialogProps {
  cue: SubtitleCue;
  styles: SubtitleStyle[];
  onClose: () => void;
  onApply: (style: string, next: boolean) => void;
  onPrevious: () => void;
  onPlay: () => void;
}

export function StylingAssistantDialog({
  cue,
  styles,
  onClose,
  onApply,
  onPrevious,
  onPlay,
}: StylingAssistantDialogProps) {
  const [style, setStyle] = useState(cue.style);
  const commit = (next: boolean) => {
    if (styles.some((item) => item.name === style)) onApply(style, next);
  };

  return (
    <Dialog
      title="Styling Assistant"
      onClose={onClose}
      footer={
        <>
          <button onClick={onPrevious}>Previous</button>
          <button onClick={onPlay}>Play</button>
          <button onClick={() => commit(false)}>Apply</button>
          <button onClick={() => commit(true)}>Apply and Next</button>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="styling-assistant-body" data-shortcut-context="Styling Assistant">
        <textarea readOnly value={cue.text} aria-label="Subtitle text" />
        <label>
          Style
          <input
            autoFocus
            list="styling-assistant-styles"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(true);
              }
            }}
          />
          <datalist id="styling-assistant-styles">
            {styles.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
        </label>
      </div>
    </Dialog>
  );
}

export function ToolInfoDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <p className="tool-info-message">{message}</p>
    </Dialog>
  );
}

export function AttachmentDialog({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <Dialog title="Attachments" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div className="attachment-dialog-body">
        <input type="file" multiple onChange={(event) => setFiles([...(event.target.files ?? [])])} />
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Group</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={`${file.name}-${file.size}`}>
                <td>{file.name}</td>
                <td>{Math.ceil(file.size / 1024)} KB</td>
                <td>{/\.(ttf|ttc|otf|pfb)$/i.test(file.name) ? 'Fonts' : 'Graphics'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Browser attachment storage is limited to this dialog session. ASS export attachment embedding will be added
          with the binary document store.
        </p>
      </div>
    </Dialog>
  );
}

export function FontCollectorDialog({
  styles,
  text,
  onClose,
}: {
  styles: SubtitleStyle[];
  text: string;
  onClose: () => void;
}) {
  const fonts = useMemo(() => {
    const names = styles.map((style) => style.fontName);
    for (const match of text.matchAll(/\\fn([^\\}]+)/g)) names.push(match[1]);
    return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [styles, text]);
  return (
    <Dialog title="Fonts Collector" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div className="tool-list-dialog">
        <p>Fonts referenced by the current subtitle:</p>
        <ul>
          {fonts.map((font) => (
            <li key={font}>{font}</li>
          ))}
        </ul>
        <p>The browser cannot copy system font files. Use this list to verify fonts before packaging the subtitle.</p>
      </div>
    </Dialog>
  );
}

export function TranslationDialog({
  cue,
  onApply,
  onClose,
}: {
  cue: SubtitleCue;
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(cue.text.replace(/\{[^}]*\}/g, ''));
  const apply = () => {
    onApply(text.replace(/\r?\n/g, '\\N'));
    onClose();
  };
  return (
    <Dialog
      title="Translation Assistant"
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>Apply</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="translation-dialog-body">
        <label>
          Original
          <textarea readOnly value={cue.text} />
        </label>
        <label>
          Translation
          <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}

export function ResampleDialog({
  scriptInfo,
  onApply,
  onClose,
}: {
  scriptInfo: Record<string, string>;
  onApply: (patch: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(Number(scriptInfo.PlayResX) || 1920);
  const [height, setHeight] = useState(Number(scriptInfo.PlayResY) || 1080);
  return (
    <Dialog
      title="Resample Resolution"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={() => {
              onApply({ PlayResX: String(Math.max(1, width)), PlayResY: String(Math.max(1, height)) });
              onClose();
            }}
          >
            OK
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          Width
          <input type="number" min={1} value={width} onChange={(event) => setWidth(Number(event.target.value))} />
        </label>
        <label>
          Height
          <input type="number" min={1} value={height} onChange={(event) => setHeight(Number(event.target.value))} />
        </label>
        <p>Script resolution metadata will be updated. Full override-tag coordinate resampling is not yet enabled.</p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="About Aegisub Web" onClose={onClose}>
      <div className="about-content">
        <img src="/icons/aegisub/app_icon.png" alt="Aegisub" width={64} height={64} />
        <h2>Aegisub Web</h2>
        <p>A browser port of Aegisub running on WebAssembly.</p>
        <dl className="about-details">
          <dt>Core</dt>
          <dd>Aegisub C++ (Emscripten WASM)</dd>
          <dt>Compatibility</dt>
          <dd>Aegisub menu / toolbar / hotkey data, ASS/SSA/SRT</dd>
          <dt>Website</dt>
          <dd>aegisub.org</dd>
          <dt>License</dt>
          <dd>BSD 3-clause (Aegisub)</dd>
        </dl>
      </div>
      <footer>
        <button onClick={onClose}>Close</button>
      </footer>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Video Details
// ---------------------------------------------------------------------------
interface VideoDetailsDialogProps {
  media: MediaSource;
  durationMs: number;
  onClose: () => void;
}

export function VideoDetailsDialog({ media, durationMs, onClose }: VideoDetailsDialogProps) {
  const sizeMb = media.file ? (media.file.size / (1024 * 1024)).toFixed(1) : '?';
  return (
    <Dialog
      title="Video Details"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      <dl className="about-details">
        <dt>File</dt>
        <dd>{media.name}</dd>
        <dt>Type</dt>
        <dd>{media.file?.type || 'media'}</dd>
        <dt>Size</dt>
        <dd>{sizeMb} MB</dd>
        <dt>Duration</dt>
        <dd>{formatEditorTime(durationMs)}</dd>
      </dl>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dummy Video（对应 Aegisub dialog_dummy_video.cpp）
// ---------------------------------------------------------------------------
interface DummyVideoDialogProps {
  scriptInfo: Record<string, string>;
  onClose: () => void;
  onApply: (options: DummyVideoOptions) => void;
}

export function DummyVideoDialog({ scriptInfo, onClose, onApply }: DummyVideoDialogProps) {
  const playResX = Number(scriptInfo.PlayResX) || 640;
  const playResY = Number(scriptInfo.PlayResY) || 480;
  const [width, setWidth] = useState(playResX);
  const [height, setHeight] = useState(playResY);
  const [length, setLength] = useState(10); // 秒
  const [color, setColor] = useState('#2fa3fe'); // Colour/Video Dummy/Last Colour
  const [pattern, setPattern] = useState(false);

  const apply = () => {
    onApply({
      width: Math.max(1, width),
      height: Math.max(1, height),
      lengthMs: Math.max(100, length) * 1000,
      color,
      pattern,
    });
    onClose();
  };

  return (
    <Dialog
      title="Dummy video options"
      onClose={onClose}
      footer={
        <>
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="dialog-fields">
        <label>
          Video resolution:
          <div className="dialog-row">
            <input
              type="number"
              min={1}
              max={10000}
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
              aria-label="Width"
            />
            <span>×</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={height}
              onChange={(event) => setHeight(Number(event.target.value))}
              aria-label="Height"
            />
          </div>
        </label>
        <label>
          Length (seconds)
          <input
            type="number"
            min={1}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
            autoFocus
          />
        </label>
        <label>
          Color
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            style={{ padding: 0, border: '1px solid #aaa', background: 'transparent' }}
          />
        </label>
        <label className="dialog-check">
          <input type="checkbox" checked={pattern} onChange={(event) => setPattern(event.target.checked)} />
          Checkerboard pattern
        </label>
      </div>
    </Dialog>
  );
}
