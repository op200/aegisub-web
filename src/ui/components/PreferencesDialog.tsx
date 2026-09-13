/**
 * Preferences 对话框（对应 Aegisub preferences.cpp / preferences_base.cpp）。
 *
 * 页面结构 = preferences.cpp Preferences::Preferences 的 wxTreebook 顺序：
 * General(+Default Styles)、Audio、Video、Interface(+Colors/Hotkeys)、Backup、
 * Automation、Advanced(+Audio/Video)。
 * 交互 = 源码语义：控件改动进 pending（Apply 按钮亮起）→ Apply 批量提交 →
 * OK = Apply + 关闭；Restore Defaults 恢复本对话框涉及的全部选项与热键表。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'

import {
  getOption,
  getOptionInt,
  getOptionString,
  importConfigJson,
  resetOptions,
  serializeConfigJson,
  setOption,
  useOptionsVersion,
} from '../../config/options'
import { clearKeyframeCache, keyframeCacheStats } from '../../storage/keyframeCacheStore'
import { loadStyleCatalogs } from '../../storage/styleCatalogStore'
import {
  AEGISUB_HOTKEYS,
  getActiveHotkeys,
  importHotkeyJson,
  resetHotkeys,
  serializeHotkeyJson,
  setActiveHotkeys,
  type HotkeyMap,
} from '../aegisubHotkeys'
import { cssColorToHex, hexToCssColor } from '../color'
import { COMMANDS, shortcutFromKeyboardEvent, type ShortcutContext } from '../commands'
import { tPlain } from '../i18n'
import { Dialog } from './dialogs'

// ---------------------------------------------------------------------------
// 页面数据定义（preferences.cpp 各页面函数的声明式版本）
// ---------------------------------------------------------------------------
type Enabler = { opt: string; invert?: boolean }

type FieldSpec =
  | { kind: 'bool'; label: string; opt: string }
  | { kind: 'int'; label: string; opt: string; min?: number; max?: number; enabler?: Enabler }
  | { kind: 'double'; label: string; opt: string; min?: number; max?: number; inc?: number }
  | { kind: 'string'; label: string; opt: string; enabler?: Enabler }
  | { kind: 'color'; label: string; opt: string; alpha?: boolean }
  | {
      kind: 'choice'
      label: string
      opt: string
      choices?: string[]
      from?: 'catalogs' | 'audio-schemes'
    }
  | { kind: 'font'; prefix: string }
  | { kind: 'browse'; label: string; opt: string; enabler?: Enabler }
  | { kind: 'note'; text: string; bold?: boolean }
  | { kind: 'skip' }

interface Section {
  title: string
  rows: FieldSpec[]
}

interface Page {
  title: string
  sub?: boolean
  sections?: Section[]
  hotkeys?: boolean
  /** Web 专属页：浏览器缓存（IndexedDB / Cache Storage / localStorage） */
  custom?: 'browser-cache' | 'config-files'
}

const SCROLL_ACTIONS = [
  'Resizes the video box',
  'Resizes the video box (reversed)',
  'Zooms the video',
  'Zooms the video (reversed)',
  'Pans the video',
  'Pans the video (X/Y swapped)',
  'Does nothing',
]
const ZOOM_CHOICES = Array.from({ length: 24 }, (_, i) => `${(i + 1) * 12.5}%`)

const PAGES: Page[] = [
  {
    title: 'General',
    sections: [
      {
        title: 'General',
        rows: [
          {
            kind: 'bool',
            label: 'Check for updates on startup',
            opt: 'App/Auto/Check For Updates',
          },
          { kind: 'bool', label: 'Show main toolbar', opt: 'App/Show Toolbar' },
          { kind: 'bool', label: 'Save UI state in subtitles files', opt: 'App/Save UI State' },
          { kind: 'skip' },
          { kind: 'int', label: 'Toolbar Icon Size', opt: 'App/Toolbar Icon Size' },
          {
            kind: 'choice',
            label: 'Automatically load linked files',
            opt: 'App/Auto/Load Linked Files',
            choices: ['Never', 'Always', 'Ask'],
          },
          { kind: 'int', label: 'Undo Levels', opt: 'Limits/Undo Levels', min: 2, max: 10000 },
        ],
      },
      {
        title: 'Recently Used Lists',
        rows: [
          { kind: 'int', label: 'Files', opt: 'Limits/MRU', min: 0, max: 16 },
          { kind: 'int', label: 'Find/Replace', opt: 'Limits/Find Replace' },
        ],
      },
    ],
  },
  {
    title: 'Default styles',
    sub: true,
    sections: [
      {
        title: 'Default style catalogs',
        rows: [
          {
            kind: 'note',
            text: 'The chosen style catalogs will be loaded when you start a new file or import files in the various formats.\n\nYou can set up style catalogs in the Style Manager.',
          },
          {
            kind: 'choice',
            label: 'New files',
            opt: 'Subtitle Format/ASS/Default Style Catalog',
            from: 'catalogs',
          },
          {
            kind: 'choice',
            label: 'MicroDVD import',
            opt: 'Subtitle Format/MicroDVD/Default Style Catalog',
            from: 'catalogs',
          },
          {
            kind: 'choice',
            label: 'SRT import',
            opt: 'Subtitle Format/SRT/Default Style Catalog',
            from: 'catalogs',
          },
          {
            kind: 'choice',
            label: 'TTXT import',
            opt: 'Subtitle Format/TTXT/Default Style Catalog',
            from: 'catalogs',
          },
          {
            kind: 'choice',
            label: 'Plain text import',
            opt: 'Subtitle Format/TXT/Default Style Catalog',
            from: 'catalogs',
          },
        ],
      },
    ],
  },
  {
    title: 'Audio',
    sections: [
      {
        title: 'Options',
        rows: [
          {
            kind: 'bool',
            label: 'Default mouse wheel to zoom',
            opt: 'Audio/Wheel Default to Zoom',
          },
          { kind: 'bool', label: 'Lock scroll on cursor', opt: 'Audio/Lock Scroll on Cursor' },
          { kind: 'bool', label: 'Snap markers by default', opt: 'Audio/Snap/Enable' },
          { kind: 'bool', label: 'Auto-focus on mouse over', opt: 'Audio/Auto/Focus' },
          {
            kind: 'bool',
            label: 'Play audio when stepping in video',
            opt: 'Audio/Plays When Stepping Video',
          },
          { kind: 'bool', label: 'Left-click-drag moves end marker', opt: 'Audio/Drag Timing' },
          {
            kind: 'int',
            label: 'Default timing length (ms)',
            opt: 'Timing/Default Duration',
            min: 0,
            max: 36000,
          },
          {
            kind: 'int',
            label: 'Default lead-in length (ms)',
            opt: 'Audio/Lead/IN',
            min: 0,
            max: 36000,
          },
          {
            kind: 'int',
            label: 'Default lead-out length (ms)',
            opt: 'Audio/Lead/OUT',
            min: 0,
            max: 36000,
          },
          {
            kind: 'int',
            label: 'Marker drag-start sensitivity (px)',
            opt: 'Audio/Start Drag Sensitivity',
            min: 1,
            max: 15,
          },
          {
            kind: 'int',
            label: 'Line boundary thickness (px)',
            opt: 'Audio/Line Boundaries Thickness',
            min: 1,
            max: 5,
          },
          {
            kind: 'int',
            label: 'Maximum snap distance (px)',
            opt: 'Audio/Snap/Distance',
            min: 0,
            max: 25,
          },
          {
            kind: 'choice',
            label: 'Show inactive lines',
            opt: 'Audio/Inactive Lines Display Mode',
            choices: ["Don't show", 'Show previous', 'Show previous and next', 'Show all'],
          },
          { kind: 'skip' },
          {
            kind: 'bool',
            label: 'Include commented inactive lines',
            opt: 'Audio/Display/Draw/Inactive Comments',
          },
        ],
      },
      {
        title: 'Display Visual Options',
        rows: [
          {
            kind: 'bool',
            label: 'Keyframes in dialogue mode',
            opt: 'Audio/Display/Draw/Keyframes in Dialogue Mode',
          },
          {
            kind: 'bool',
            label: 'Keyframes in karaoke mode',
            opt: 'Audio/Display/Draw/Keyframes in Karaoke Mode',
          },
          { kind: 'bool', label: 'Cursor time', opt: 'Audio/Display/Draw/Cursor Time' },
          { kind: 'bool', label: 'Video position', opt: 'Audio/Display/Draw/Video Position' },
          { kind: 'bool', label: 'Seconds boundaries', opt: 'Audio/Display/Draw/Seconds' },
          { kind: 'skip' },
          {
            kind: 'choice',
            label: 'Waveform Style',
            opt: 'Audio/Display/Waveform Style',
            choices: ['Maximum', 'Maximum + Average'],
          },
        ],
      },
      { title: 'Audio labels', rows: [{ kind: 'font', prefix: 'Audio/Karaoke/' }] },
    ],
  },
  {
    title: 'Video',
    sections: [
      {
        title: 'Options',
        rows: [
          { kind: 'bool', label: 'Show keyframes in slider', opt: 'Video/Slider/Show Keyframes' },
          { kind: 'skip' },
          {
            kind: 'bool',
            label: 'Only show visual tools when mouse is over video',
            opt: 'Tool/Visual/Autohide',
          },
          { kind: 'skip' },
          {
            kind: 'bool',
            label: 'Seek video to line start on selection change',
            opt: 'Video/Subtitle Sync',
          },
          { kind: 'skip' },
          {
            kind: 'bool',
            label: 'Automatically open audio when opening video',
            opt: 'Video/Open Audio',
          },
          { kind: 'skip' },
          {
            kind: 'choice',
            label: 'Scrolling on the video display',
            opt: 'Video/Scroll Action',
            choices: SCROLL_ACTIONS,
          },
          {
            kind: 'choice',
            label: 'Ctrl+Scrolling on the video display',
            opt: 'Video/Ctrl Scroll Action',
            choices: SCROLL_ACTIONS,
          },
          {
            kind: 'choice',
            label: 'Shift+Scrolling on the video display',
            opt: 'Video/Shift Scroll Action',
            choices: SCROLL_ACTIONS,
          },
          {
            kind: 'choice',
            label: 'Default Zoom',
            opt: 'Video/Default Zoom',
            choices: ZOOM_CHOICES,
          },
          { kind: 'int', label: 'Fast jump step in frames', opt: 'Video/Slider/Fast Jump Step' },
          {
            kind: 'choice',
            label: 'Screenshot save path',
            opt: 'Path/Screenshot',
            choices: ['?video', '?script', '.'],
          },
        ],
      },
      {
        title: 'Script Resolution',
        rows: [
          {
            kind: 'bool',
            label: 'Use resolution of first video opened',
            opt: 'Subtitle/Default Resolution/Auto',
          },
          { kind: 'skip' },
          {
            kind: 'int',
            label: 'Default width',
            opt: 'Subtitle/Default Resolution/Width',
            enabler: { opt: 'Subtitle/Default Resolution/Auto', invert: true },
          },
          {
            kind: 'int',
            label: 'Default height',
            opt: 'Subtitle/Default Resolution/Height',
            enabler: { opt: 'Subtitle/Default Resolution/Auto', invert: true },
          },
          {
            kind: 'choice',
            label: 'Match video resolution on open',
            opt: 'Video/PlayRes Mismatch',
            choices: ['Never', 'Ask', 'Always resample'],
          },
        ],
      },
      {
        title: 'Layout Resolution',
        rows: [
          {
            kind: 'choice',
            label: 'Set layout resolution from video on open',
            opt: 'Video/No LayoutRes in Script',
            choices: ['Never', 'Ask', 'Always set', 'Always set from script resolution'],
          },
          {
            kind: 'choice',
            label: 'Prompt on layout resolution mismatch',
            opt: 'Video/LayoutRes Mismatch',
            choices: ['Never', 'When aspect ratio changes', 'Always'],
          },
        ],
      },
      {
        title: 'YCbCr Matrix',
        rows: [
          {
            kind: 'bool',
            label: 'Warn on untagged video color matrix',
            opt: 'Video/Untagged Matrix Warning',
          },
          { kind: 'bool', label: 'Warn on HDR/WCG video', opt: 'Video/HDR Video Warning' },
          {
            kind: 'choice',
            label: "Use video's YCbCr Matrix when script has no matrix set",
            opt: 'Video/No YCbCr Matrix in Script',
            choices: ['Never', 'Ask', 'Always set'],
          },
          {
            kind: 'choice',
            label: "Match video's YCbCr Matrix on open",
            opt: 'Video/YCbCr Matrix Mismatch',
            choices: ['Never', 'Ask', 'Always set'],
          },
        ],
      },
    ],
  },
  {
    title: 'Interface',
    sections: [
      {
        title: 'Edit Box',
        rows: [
          { kind: 'bool', label: 'Enable call tips', opt: 'App/Call Tips' },
          { kind: 'bool', label: 'Overwrite in time boxes', opt: 'Subtitle/Time Edit/Insert Mode' },
          { kind: 'bool', label: 'Shift+Enter adds \\n', opt: 'Subtitle/Edit Box/Soft Line Break' },
          { kind: 'bool', label: 'Enable syntax highlighting', opt: 'Subtitle/Highlight/Syntax' },
          { kind: 'browse', label: 'Dictionaries path', opt: 'Path/Dictionary' },
          { kind: 'font', prefix: 'Subtitle/Edit Box/' },
        ],
      },
      {
        title: 'Character Counter',
        rows: [
          {
            kind: 'int',
            label: 'Maximum characters per line',
            opt: 'Subtitle/Character Limit',
            min: 0,
            max: 1000,
          },
          {
            kind: 'int',
            label: 'Characters Per Second Warning Threshold',
            opt: 'Subtitle/Character Counter/CPS Warning Threshold',
            min: 0,
            max: 1000,
          },
          {
            kind: 'int',
            label: 'Characters Per Second Error Threshold',
            opt: 'Subtitle/Character Counter/CPS Error Threshold',
            min: 0,
            max: 1000,
          },
          {
            kind: 'bool',
            label: 'Ignore whitespace',
            opt: 'Subtitle/Character Counter/Ignore Whitespace',
          },
          {
            kind: 'bool',
            label: 'Ignore punctuation',
            opt: 'Subtitle/Character Counter/Ignore Punctuation',
          },
        ],
      },
      {
        title: 'Grid',
        rows: [
          { kind: 'bool', label: 'Focus grid on click', opt: 'Subtitle/Grid/Focus Allow' },
          {
            kind: 'bool',
            label: 'Highlight visible subtitles',
            opt: 'Subtitle/Grid/Highlight Subtitles in Frame',
          },
          {
            kind: 'string',
            label: 'Hide overrides symbol',
            opt: 'Subtitle/Grid/Hide Overrides Char',
          },
          { kind: 'font', prefix: 'Subtitle/Grid/' },
        ],
      },
      {
        title: 'Translation Assistant',
        rows: [
          {
            kind: 'bool',
            label: 'Skip over whitespace',
            opt: 'Tool/Translation Assistant/Skip Whitespace',
          },
        ],
      },
    ],
  },
  {
    title: 'Colors',
    sub: true,
    sections: [
      {
        title: 'Audio Display',
        rows: [
          { kind: 'color', label: 'Play cursor', opt: 'Colour/Audio Display/Play Cursor' },
          {
            kind: 'color',
            label: 'Current frame range',
            opt: 'Colour/Audio Display/Current Frame Range',
            alpha: true,
          },
          {
            kind: 'color',
            label: 'Previous frame range',
            opt: 'Colour/Audio Display/Previous Frame Range',
            alpha: true,
          },
          {
            kind: 'color',
            label: 'Line boundary start',
            opt: 'Colour/Audio Display/Line boundary Start',
          },
          {
            kind: 'color',
            label: 'Line boundary end',
            opt: 'Colour/Audio Display/Line boundary End',
          },
          {
            kind: 'color',
            label: 'Line boundary inactive line',
            opt: 'Colour/Audio Display/Line Boundary Inactive Line',
          },
          {
            kind: 'color',
            label: 'Syllable boundaries',
            opt: 'Colour/Audio Display/Syllable Boundaries',
          },
          { kind: 'color', label: 'Seconds boundaries', opt: 'Colour/Audio Display/Seconds Line' },
        ],
      },
      {
        title: 'Syntax Highlighting',
        rows: [
          { kind: 'color', label: 'Background', opt: 'Colour/Subtitle/Background' },
          { kind: 'color', label: 'Normal', opt: 'Colour/Subtitle/Syntax/Normal' },
          { kind: 'color', label: 'Comments', opt: 'Colour/Subtitle/Syntax/Comment' },
          {
            kind: 'color',
            label: 'Drawing Commands',
            opt: 'Colour/Subtitle/Syntax/Drawing Command',
          },
          { kind: 'color', label: 'Drawing X Coords', opt: 'Colour/Subtitle/Syntax/Drawing X' },
          { kind: 'color', label: 'Drawing Y Coords', opt: 'Colour/Subtitle/Syntax/Drawing Y' },
          {
            kind: 'bool',
            label: 'Underline Spline Endpoints',
            opt: 'Colour/Subtitle/Syntax/Underline/Drawing Endpoint',
          },
          { kind: 'skip' },
          { kind: 'color', label: 'Brackets', opt: 'Colour/Subtitle/Syntax/Brackets' },
          {
            kind: 'color',
            label: 'Slashes and Parentheses',
            opt: 'Colour/Subtitle/Syntax/Slashes',
          },
          { kind: 'color', label: 'Tags', opt: 'Colour/Subtitle/Syntax/Tags' },
          { kind: 'color', label: 'Parameters', opt: 'Colour/Subtitle/Syntax/Parameters' },
          { kind: 'color', label: 'Error', opt: 'Colour/Subtitle/Syntax/Error' },
          {
            kind: 'color',
            label: 'Error Background',
            opt: 'Colour/Subtitle/Syntax/Background/Error',
          },
          { kind: 'color', label: 'Line Break', opt: 'Colour/Subtitle/Syntax/Line Break' },
          {
            kind: 'color',
            label: 'Karaoke templates',
            opt: 'Colour/Subtitle/Syntax/Karaoke Template',
          },
          {
            kind: 'color',
            label: 'Karaoke variables',
            opt: 'Colour/Subtitle/Syntax/Karaoke Variable',
          },
        ],
      },
      {
        title: 'Audio Color Schemes',
        rows: [
          {
            kind: 'choice',
            label: 'Spectrum',
            opt: 'Colour/Audio Display/Spectrum',
            from: 'audio-schemes',
          },
          {
            kind: 'choice',
            label: 'Waveform',
            opt: 'Colour/Audio Display/Waveform',
            from: 'audio-schemes',
          },
        ],
      },
      {
        title: 'Subtitle Grid',
        rows: [
          { kind: 'color', label: 'Standard foreground', opt: 'Colour/Subtitle Grid/Standard' },
          {
            kind: 'color',
            label: 'Standard background',
            opt: 'Colour/Subtitle Grid/Background/Background',
          },
          { kind: 'color', label: 'Selection foreground', opt: 'Colour/Subtitle Grid/Selection' },
          {
            kind: 'color',
            label: 'Selection background',
            opt: 'Colour/Subtitle Grid/Background/Selection',
          },
          { kind: 'color', label: 'Collision foreground', opt: 'Colour/Subtitle Grid/Collision' },
          {
            kind: 'color',
            label: 'In frame background',
            opt: 'Colour/Subtitle Grid/Background/Inframe',
          },
          {
            kind: 'color',
            label: 'Comment background',
            opt: 'Colour/Subtitle Grid/Background/Comment',
          },
          {
            kind: 'color',
            label: 'Selected comment background',
            opt: 'Colour/Subtitle Grid/Background/Selected Comment',
          },
          { kind: 'color', label: 'Header background', opt: 'Colour/Subtitle Grid/Header' },
          { kind: 'color', label: 'Left Column', opt: 'Colour/Subtitle Grid/Left Column' },
          { kind: 'color', label: 'Active Line Border', opt: 'Colour/Subtitle Grid/Active Border' },
          { kind: 'color', label: 'Lines', opt: 'Colour/Subtitle Grid/Lines' },
          { kind: 'color', label: 'CPS Error', opt: 'Colour/Subtitle Grid/CPS Error' },
        ],
      },
      {
        title: 'Visual Typesetting Tools',
        rows: [
          { kind: 'color', label: 'Primary Lines', opt: 'Colour/Visual Tools/Lines Primary' },
          { kind: 'color', label: 'Secondary Lines', opt: 'Colour/Visual Tools/Lines Secondary' },
          {
            kind: 'color',
            label: 'Primary Highlight',
            opt: 'Colour/Visual Tools/Highlight Primary',
          },
          {
            kind: 'color',
            label: 'Secondary Highlight',
            opt: 'Colour/Visual Tools/Highlight Secondary',
          },
          {
            kind: 'double',
            label: 'Shaded Area Alpha',
            opt: 'Colour/Visual Tools/Shaded Area Alpha',
            min: 0,
            max: 1,
            inc: 0.1,
          },
        ],
      },
    ],
  },
  { title: 'Hotkeys', sub: true, hotkeys: true },
  {
    title: 'Backup',
    sections: [
      {
        title: 'Automatic Save',
        rows: [
          { kind: 'bool', label: 'Enable', opt: 'App/Auto/Save' },
          { kind: 'skip' },
          {
            kind: 'int',
            label: 'Interval in seconds',
            opt: 'App/Auto/Save Every Seconds',
            min: 1,
            enabler: { opt: 'App/Auto/Save' },
          },
          {
            kind: 'browse',
            label: 'Path',
            opt: 'Path/Auto/Save',
            enabler: { opt: 'App/Auto/Save' },
          },
          {
            kind: 'bool',
            label: 'Autosave after every change',
            opt: 'App/Auto/Save on Every Change',
          },
        ],
      },
      {
        title: 'Automatic Backup',
        rows: [
          { kind: 'bool', label: 'Enable', opt: 'App/Auto/Backup' },
          { kind: 'skip' },
          {
            kind: 'browse',
            label: 'Path',
            opt: 'Path/Auto/Backup',
            enabler: { opt: 'App/Auto/Backup' },
          },
        ],
      },
    ],
  },
  {
    title: 'Automation',
    sections: [
      {
        title: 'General',
        rows: [
          { kind: 'browse', label: 'Base path', opt: 'Path/Automation/Base' },
          { kind: 'browse', label: 'Include path', opt: 'Path/Automation/Include' },
          { kind: 'browse', label: 'Auto-load path', opt: 'Path/Automation/Autoload' },
          {
            kind: 'choice',
            label: 'Trace level',
            opt: 'Automation/Trace Level',
            choices: ['0: Fatal', '1: Error', '2: Warning', '3: Hint', '4: Debug', '5: Trace'],
          },
          {
            kind: 'choice',
            label: 'Autoreload on Export',
            opt: 'Automation/Autoreload Mode',
            choices: [
              'No scripts',
              'Subtitle-local scripts',
              'Global autoload scripts',
              'All scripts',
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Advanced',
    sections: [
      {
        title: 'General',
        rows: [
          {
            kind: 'note',
            bold: true,
            text: "Changing these settings might result in bugs and/or crashes. Do not touch these unless you know what you're doing.",
          },
        ],
      },
    ],
  },
  {
    title: 'Audio',
    sub: true,
    sections: [
      {
        title: 'Expert',
        rows: [
          {
            kind: 'choice',
            label: 'Audio provider',
            opt: 'Audio/Provider',
            choices: ['ffmpegsource', 'pcm'],
          },
          { kind: 'choice', label: 'Audio player', opt: 'Audio/Player', choices: ['portaudio'] },
        ],
      },
      {
        title: 'Cache',
        rows: [
          {
            kind: 'choice',
            label: 'Cache type',
            opt: 'Audio/Cache/Type',
            choices: ['None (NOT RECOMMENDED)', 'RAM', 'Hard Disk'],
          },
          { kind: 'browse', label: 'Path', opt: 'Audio/Cache/HD/Location' },
        ],
      },
      {
        title: 'Spectrum',
        rows: [
          {
            kind: 'choice',
            label: 'Quality',
            opt: 'Audio/Renderer/Spectrum/Quality',
            choices: ['Regular quality', 'Better quality', 'High quality', 'Insane quality'],
          },
          {
            kind: 'choice',
            label: 'Frequency mapping',
            opt: 'Audio/Renderer/Spectrum/FreqCurve',
            choices: ['Linear', 'Extended', 'Medium', 'Compressed', 'Logarithmic'],
          },
          {
            kind: 'int',
            label: 'Cache memory max (MB)',
            opt: 'Audio/Renderer/Spectrum/Memory Max',
            min: 2,
            max: 1024,
          },
        ],
      },
    ],
  },
  {
    title: 'Video',
    sub: true,
    sections: [
      {
        title: 'Expert',
        rows: [
          {
            kind: 'choice',
            label: 'Video provider',
            opt: 'Video/Provider',
            choices: ['avisynth', 'ffmpegsource', 'dummy'],
          },
          {
            kind: 'choice',
            label: 'Subtitles provider',
            opt: 'Subtitle/Provider',
            choices: ['jassub', 'canvas'],
          },
        ],
      },
    ],
  },
  // Web 专属页（无原版对应）：config.json / hotkey.json 导入导出、浏览器存储缓存
  { title: 'Config files', custom: 'config-files' },
  { title: 'Browser cache', custom: 'browser-cache' },
]

/** Restore Defaults 涉及的全部选项名（preferences.cpp option_names 的声明式版本） */
const ALL_OPTION_NAMES: string[] = PAGES.flatMap((page) =>
  (page.sections ?? []).flatMap((section) =>
    section.rows.flatMap((row) => {
      switch (row.kind) {
        case 'bool':
        case 'int':
        case 'double':
        case 'string':
        case 'color':
        case 'choice':
        case 'browse':
          return [row.opt]
        case 'font':
          return [`${row.prefix}Font Face`, `${row.prefix}Font Size`]
        default:
          return []
      }
    }),
  ),
)

// ---------------------------------------------------------------------------
// 热键编辑页（Interface_Hotkeys + HotkeyDataViewModel）
// ---------------------------------------------------------------------------
const HOTKEY_CONTEXTS = Object.keys(AEGISUB_HOTKEYS) as ShortcutContext[]
const COMMAND_NAMES = Object.keys(COMMANDS).sort()

interface HotkeyRow {
  context: ShortcutContext
  command: string
  key: string
}

function flattenHotkeys(map: HotkeyMap): HotkeyRow[] {
  const rows: HotkeyRow[] = []
  for (const context of HOTKEY_CONTEXTS) {
    for (const [command, keys] of Object.entries(map[context] ?? {})) {
      for (const key of keys) rows.push({ context, command, key })
    }
  }
  return rows
}

function commitHotkeys(rows: HotkeyRow[]): HotkeyMap {
  const map: HotkeyMap = {}
  for (const { context, command, key } of rows) {
    if (!command || !key) continue
    const bucket = (map[context] ??= {})
    bucket[command] ??= []
    if (!bucket[command].includes(key)) bucket[command].push(key)
  }
  return map
}

// ---------------------------------------------------------------------------
// 控件（OptionPage::OptionAdd / OptionChoice / OptionFont / OptionBrowse）
// ---------------------------------------------------------------------------
interface ControlProps {
  value: unknown
  onCommit: (value: unknown) => void
  enabled: boolean
}

function BoolControl({ value, onCommit, enabled }: ControlProps) {
  return (
    <input
      type="checkbox"
      checked={Boolean(value)}
      disabled={!enabled}
      onChange={(event) => onCommit(event.target.checked)}
    />
  )
}

function IntControl({
  value,
  onCommit,
  enabled,
  min,
  max,
}: ControlProps & { min?: number; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(typeof value === 'number' ? value : 0)
  const commit = (raw: string) => {
    setDraft(null)
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && Number.isInteger(parsed)) onCommit(parsed)
  }
  return (
    <input
      type="number"
      className="pref-number"
      value={text}
      min={min}
      max={max}
      disabled={!enabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value)
      }}
    />
  )
}

function DoubleControl({
  value,
  onCommit,
  enabled,
  min,
  max,
  inc,
}: ControlProps & { min?: number; max?: number; inc?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(typeof value === 'number' ? value : 0)
  const commit = (raw: string) => {
    setDraft(null)
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) onCommit(parsed)
  }
  return (
    <span className="pref-double">
      <input
        type="number"
        className="pref-number"
        value={text}
        min={min}
        max={max}
        step={inc}
        disabled={!enabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value)
        }}
      />
      <input
        type="range"
        min={min ?? 0}
        max={max ?? 1}
        step={inc ?? 0.1}
        value={Number(value)}
        disabled={!enabled}
        onChange={(event) => onCommit(Number(event.target.value))}
      />
    </span>
  )
}

function StringControl({ value, onCommit, enabled }: ControlProps) {
  return (
    <input
      value={String(value ?? '')}
      disabled={!enabled}
      onChange={(event) => onCommit(event.target.value)}
    />
  )
}

function ColorControl({ value, onCommit, enabled, alpha }: ControlProps & { alpha?: boolean }) {
  const raw = String(value ?? '')
  const parts = /rgba?\(([^)]*)\)/
    .exec(raw)?.[1]
    .split(',')
    .map((item) => item.trim())
  const alphaValue =
    raw.startsWith('rgba') && parts && parts.length >= 4 ? Math.min(255, Number(parts[3])) : 255
  return (
    <span className="pref-color">
      <input
        type="color"
        value={cssColorToHex(raw, '#000000')}
        disabled={!enabled}
        onChange={(event) => onCommit(hexToCssColor(event.target.value))}
      />
      {alpha && (
        <input
          type="number"
          className="pref-number pref-alpha"
          title={tPlain('Alpha (0-255)')}
          min={0}
          max={255}
          value={alphaValue}
          disabled={!enabled}
          onChange={(event) => {
            const next = Math.max(0, Math.min(255, Number(event.target.value) || 0))
            const base = cssColorToHex(raw, '#ffffff').replace('#', '')
            const r = Number.parseInt(base.slice(0, 2), 16)
            const g = Number.parseInt(base.slice(2, 4), 16)
            const b = Number.parseInt(base.slice(4, 6), 16)
            onCommit(`rgba(${r},${g},${b},${next})`)
          }}
        />
      )}
      <code className="pref-color-value">{raw || tPlain('(default)')}</code>
    </span>
  )
}

function ChoiceControl({
  value,
  onCommit,
  choices,
  enabled,
}: ControlProps & { choices: string[] }) {
  const isInt = typeof value === 'number'
  const index = isInt
    ? Number(value) < choices.length
      ? Number(value)
      : 0
    : choices.indexOf(String(value))
  return (
    <select
      value={index >= 0 ? index : 0}
      disabled={!enabled}
      onChange={(event) =>
        onCommit(isInt ? Number(event.target.value) : choices[Number(event.target.value)])
      }
    >
      {choices.map((choice, i) => (
        <option key={choice} value={i}>
          {choice}
        </option>
      ))}
    </select>
  )
}

function FontControl({
  prefix,
  onCommit,
}: {
  prefix: string
  onCommit: (opt: string, value: unknown) => void
}) {
  const face = getOptionString(`${prefix}Font Face`)
  const size = getOptionInt(`${prefix}Font Size`)
  return (
    <span className="pref-font">
      <input
        placeholder={tPlain('Font Face')}
        value={face}
        onChange={(event) => onCommit(`${prefix}Font Face`, event.target.value)}
      />
      <input
        type="number"
        className="pref-number"
        title={tPlain('Font Size')}
        min={3}
        max={42}
        value={size}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          if (Number.isInteger(parsed)) onCommit(`${prefix}Font Size`, parsed)
        }}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// 对话框主体
// ---------------------------------------------------------------------------
interface PreferencesDialogProps {
  onClose: () => void
}

export function PreferencesDialog({ onClose }: PreferencesDialogProps) {
  useOptionsVersion() // Restore Defaults 后立即反映到控件
  const [page, setPage] = useState(() =>
    Math.min(PAGES.length - 1, Math.max(0, getOptionInt('Tool/Preferences/Page'))),
  )
  const [pending, setPending] = useState<Map<string, unknown>>(new Map())
  const [hotkeyRows, setHotkeyRows] = useState<HotkeyRow[] | null>(null)
  const [hotkeyFilter, setHotkeyFilter] = useState('')
  const [capturing, setCapturing] = useState<number | null>(null)

  const read = (opt: string): unknown => (pending.has(opt) ? pending.get(opt) : getOption(opt))
  const setPendingValue = (opt: string, value: unknown) =>
    setPending((current) => new Map(current).set(opt, value))

  const hasPending = pending.size > 0 || hotkeyRows !== null
  const dirtyCount =
    pending.size +
    (hotkeyRows
      ? JSON.stringify(hotkeyRows) === JSON.stringify(flattenHotkeys(getActiveHotkeys()))
        ? 0
        : 1
      : 0)

  const apply = () => {
    for (const [opt, value] of pending) setOption(opt, value)
    setPending(new Map())
    if (hotkeyRows) {
      setActiveHotkeys(commitHotkeys(hotkeyRows))
      setHotkeyRows(null)
    }
  }

  const restoreDefaults = () => {
    if (
      !window.confirm(
        tPlain(
          'Are you sure that you want to restore the defaults? All your settings will be overridden.',
        ),
      )
    )
      return
    resetOptions(ALL_OPTION_NAMES)
    resetHotkeys()
    setPending(new Map())
    setHotkeyRows(null)
  }

  const showPage = (index: number) => {
    setPage(index)
    setOption('Tool/Preferences/Page', index)
  }

  // 热键捕获：捕获态时接管所有按键（HotkeyRenderer::OnKeyDown）
  useEffect(() => {
    if (capturing === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      const shortcut = shortcutFromKeyboardEvent(event)
      setHotkeyRows((rows) =>
        rows ? rows.map((row, i) => (i === capturing ? { ...row, key: shortcut } : row)) : rows,
      )
      setCapturing(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing])

  const currentPage = PAGES[page]
  const body = currentPage.hotkeys ? (
    <HotkeysPage
      rows={hotkeyRows ?? flattenHotkeys(getActiveHotkeys())}
      draftActive={hotkeyRows !== null}
      filter={hotkeyFilter}
      capturing={capturing}
      onFilter={setHotkeyFilter}
      onEdit={(index) => setCapturing(index)}
      onDelete={(index) =>
        setHotkeyRows((rows) => (rows ? rows.filter((_, i) => i !== index) : rows))
      }
      onAdd={(context) => {
        const base = hotkeyRows ?? flattenHotkeys(getActiveHotkeys())
        const next = [...base, { context, command: '', key: '' }]
        setHotkeyRows(next)
        setCapturing(next.length - 1)
      }}
      onCommandChange={(index, command) =>
        setHotkeyRows((rows) =>
          rows ? rows.map((row, i) => (i === index ? { ...row, command } : row)) : rows,
        )
      }
      onStartDraft={() => setHotkeyRows(flattenHotkeys(getActiveHotkeys()))}
    />
  ) : currentPage.custom === 'config-files' ? (
    <ConfigFilesPage />
  ) : currentPage.custom === 'browser-cache' ? (
    <BrowserCachePage />
  ) : (
    (currentPage.sections ?? []).map((section) => (
      <fieldset className="pref-section" key={section.title}>
        <legend>{tPlain(section.title)}</legend>
        {section.rows.map((row, rowIndex) => {
          if (row.kind === 'skip') return null
          if (row.kind === 'note')
            return (
              <p className={`pref-note${row.bold ? ' bold' : ''}`} key={rowIndex}>
                {tPlain(row.text)
                  .split('\n')
                  .map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
                  ))}
              </p>
            )
          if (row.kind === 'font')
            return (
              <div className="pref-row pref-row-font" key={`${row.kind}-${rowIndex}`}>
                <span className="pref-label">{tPlain('Font')}</span>
                <FontControl prefix={row.prefix} onCommit={setPendingValue} />
              </div>
            )
          const commit = (value: unknown) => setPendingValue(row.opt, value)
          const value = read(row.opt)
          const isEnabled = (): boolean => {
            if (row.kind === 'bool' || !('enabler' in row) || !row.enabler) return true
            const flag = read(row.enabler.opt)
            return row.enabler.invert ? !flag : Boolean(flag)
          }
          const enabled = isEnabled()
          let control: ReactNode
          const enabledProp = { value, onCommit: commit, enabled }
          switch (row.kind) {
            case 'bool':
              control = <BoolControl {...enabledProp} />
              break
            case 'int':
              control = <IntControl {...enabledProp} min={row.min} max={row.max} />
              break
            case 'double':
              control = <DoubleControl {...enabledProp} min={row.min} max={row.max} inc={row.inc} />
              break
            case 'string':
            case 'browse':
              control = <StringControl {...enabledProp} />
              break
            case 'color':
              control = <ColorControl {...enabledProp} alpha={row.alpha} />
              break
            case 'choice': {
              const choices =
                row.choices ??
                (row.from === 'catalogs'
                  ? loadStyleCatalogs().map((catalog) => catalog.name)
                  : getOption<string[]>('Audio/Colour Schemes'))
              control = <ChoiceControl {...enabledProp} choices={choices} />
              break
            }
          }
          return (
            <div
              className={`pref-row${row.kind === 'bool' ? ' pref-row-bool' : ''}`}
              key={`${row.opt}-${rowIndex}`}
            >
              {row.kind === 'bool' ? (
                <label className="pref-label">
                  {control} {tPlain(row.label)}
                </label>
              ) : (
                <>
                  <span className="pref-label">{tPlain(row.label)}</span>
                  {control}
                </>
              )}
            </div>
          )
        })}
      </fieldset>
    ))
  )

  return (
    <Dialog
      title={tPlain('Preferences')}
      onClose={onClose}
      footer={
        <>
          <button onClick={restoreDefaults}>{tPlain('Restore Defaults')}</button>
          <span className="dialog-spacer" />
          <button
            onClick={() => {
              apply()
              onClose()
            }}
          >
            {tPlain('OK')}
          </button>
          <button onClick={onClose}>{tPlain('Cancel')}</button>
          <button disabled={!hasPending} onClick={apply}>
            {tPlain('Apply')}
            {dirtyCount > 0 && hasPending ? ` (${dirtyCount})` : ''}
          </button>
          <button
            onClick={() =>
              window.open('https://aegisub.org/docs/latest/preferences/', '_blank', 'noopener')
            }
          >
            {tPlain('Help')}
          </button>
        </>
      }
    >
      <div className="preferences">
        <nav className="pref-tree" aria-label={tPlain('Preference pages')}>
          {PAGES.map((item, index) => (
            <button
              key={`${item.title}-${index}`}
              className={`pref-tree-item${index === page ? ' active' : ''}${item.sub ? ' sub' : ''}`}
              onClick={() => showPage(index)}
            >
              {tPlain(item.title)}
              {item.hotkeys && hotkeyRows ? ' *' : ''}
            </button>
          ))}
        </nav>
        <div className="pref-body">{body}</div>
      </div>
    </Dialog>
  )
}

interface HotkeysPageProps {
  rows: HotkeyRow[]
  draftActive: boolean
  filter: string
  capturing: number | null
  onFilter: (value: string) => void
  onEdit: (index: number) => void
  onDelete: (index: number) => void
  onAdd: (context: ShortcutContext) => void
  onCommandChange: (index: number, command: string) => void
  onStartDraft: () => void
}

function HotkeysPage(props: HotkeysPageProps) {
  const {
    rows,
    draftActive,
    filter,
    capturing,
    onFilter,
    onEdit,
    onDelete,
    onAdd,
    onCommandChange,
    onStartDraft,
  } = props
  const needle = filter.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
          if (!needle) return true
          const description = COMMANDS[row.command]?.help ?? COMMANDS[row.command]?.label ?? ''
          return (
            row.command.toLowerCase().includes(needle) ||
            row.key.toLowerCase().includes(needle) ||
            description.toLowerCase().includes(needle)
          )
        }),
    [rows, needle],
  )

  const present = new Set(rows.map((row) => row.context))
  const contexts = [...HOTKEY_CONTEXTS, ...[...present].filter((c) => !HOTKEY_CONTEXTS.includes(c))]

  return (
    <div className="pref-hotkeys">
      <div className="pref-hotkey-toolbar">
        <input
          className="pref-hotkey-search"
          placeholder={tPlain('Search')}
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
        {!draftActive && <button onClick={onStartDraft}>{tPlain('Edit')}</button>}
      </div>
      <div className="pref-hotkey-list">
        {contexts.map((context) => {
          const contextRows = filtered.filter(({ row }) => row.context === context)
          if (!contextRows.length && needle) return null
          return (
            <div className="pref-hotkey-context" key={context}>
              <div className="pref-hotkey-context-header">
                <strong>{context}</strong>
                <button disabled={!draftActive} onClick={() => onAdd(context)}>
                  {tPlain('New')}
                </button>
              </div>
              {contextRows.map(({ row, index }) => {
                const cmd = row.command ? COMMANDS[row.command] : undefined
                return (
                  <div
                    className={`pref-hotkey-row${row.command && !COMMANDS[row.command] ? ' invalid' : ''}`}
                    key={index}
                  >
                    <button
                      className={`pref-hotkey-key${capturing === index ? ' capturing' : ''}`}
                      disabled={!draftActive || capturing !== null}
                      title={
                        capturing === index
                          ? tPlain('Press a key (Esc to cancel)')
                          : tPlain('Click to set hotkey')
                      }
                      onClick={() => onEdit(index)}
                    >
                      {capturing === index ? tPlain('Press key…') : row.key || tPlain('(none)')}
                    </button>
                    <input
                      list="pref-hotkey-commands"
                      disabled={!draftActive}
                      value={row.command}
                      onChange={(event) => onCommandChange(index, event.target.value)}
                    />
                    <span
                      className="pref-hotkey-desc"
                      title={cmd?.help ? tPlain(cmd.help) : (cmd?.label ?? '')}
                    >
                      {cmd?.help
                        ? tPlain(cmd.help)
                        : (cmd?.label ?? (row.command ? tPlain('Invalid command') : ''))}
                    </span>
                    <button
                      className="pref-hotkey-delete"
                      disabled={!draftActive}
                      aria-label={tPlain('Delete hotkey')}
                      onClick={() => onDelete(index)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <datalist id="pref-hotkey-commands">
        {COMMAND_NAMES.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Browser cache 页（Web 专属，无原版对应）：浏览器各存储的占用与清除
// ---------------------------------------------------------------------------
interface StoreInfo {
  name: string
  count: number
  bytes: number
}

interface DatabaseInfo {
  name: string
  version: number
  stores: StoreInfo[]
}

interface StorageAreaInfo {
  total: number
  entries: { key: string; bytes: number }[]
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** 估算单条记录体积：Blob/File 用真实 size，其余按字符串/序列化字节数 */
function storedValueSize(value: unknown): number {
  if (value == null) return 0
  if (value instanceof Blob) return value.size
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (typeof value === 'string') return value.length * 2
  try {
    const serialized = JSON.stringify(value)
    return serialized ? serialized.length * 2 : 0
  } catch {
    return 0
  }
}

function inspectDatabase(name: string): Promise<DatabaseInfo> {
  return new Promise((resolve, reject) => {
    // 不带版本号打开：读取当前版本，不触发升级
    const request = indexedDB.open(name)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const stores = [...database.objectStoreNames].map(
        (storeName) =>
          new Promise<StoreInfo>((resolveStore, rejectStore) => {
            let count = 0
            let bytes = 0
            const cursor = database
              .transaction(storeName, 'readonly')
              .objectStore(storeName)
              .openCursor()
            cursor.onsuccess = () => {
              const current = cursor.result
              if (current) {
                count += 1
                bytes += storedValueSize(current.value)
                current.continue()
              } else {
                resolveStore({ name: storeName, count, bytes })
              }
            }
            cursor.onerror = () => rejectStore(cursor.error)
          }),
      )
      Promise.all(stores)
        .then((resolved) => {
          const version = database.version
          database.close()
          resolve({ name, version, stores: resolved })
        })
        .catch((cause) => {
          database.close()
          reject(cause)
        })
    }
  })
}

async function listDatabases(): Promise<DatabaseInfo[]> {
  if (!indexedDB.databases) {
    // 无 databases() 的环境退回已知库名
    return [await inspectDatabase('aegisub-web')]
  }
  const infos = await indexedDB.databases()
  // 打不开（被占用等）的库按 null 过滤
  const inspected = await Promise.all(
    infos
      .filter((info) => info.name)
      .map((info) => inspectDatabase(info.name as string).catch(() => null)),
  )
  return inspected.filter((database): database is DatabaseInfo => database !== null)
}

function inspectStorageArea(area: Storage): StorageAreaInfo {
  const entries: { key: string; bytes: number }[] = []
  let total = 0
  for (let i = 0; i < area.length; i += 1) {
    const key = area.key(i)
    if (key === null) continue
    const bytes = (area.getItem(key) ?? '').length * 2
    entries.push({ key, bytes })
    total += bytes
  }
  return { total, entries }
}

/**
 * Config files 页（Web 专属，无原版对应——桌面版直接操作 ?user 目录下的
 * config.json / hotkey.json，浏览器无文件系统故以导入导出替代）。
 * 导出格式与 Aegisub 桌面版完全一致；导入兼容桌面版新版（字符串数组）与
 * 旧版（{"modifiers": [...], "key": "..."}）hotkey.json 及其 config.json。
 */
function ConfigFilesPage() {
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const configInputRef = useRef<HTMLInputElement>(null)
  const hotkeyInputRef = useRef<HTMLInputElement>(null)

  const download = (name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importFile = async (file: File, kind: 'config' | 'hotkey') => {
    setMessage('')
    setError('')
    try {
      const text = await file.text()
      const count = kind === 'config' ? importConfigJson(text) : importHotkeyJson(text)
      setMessage(
        kind === 'config'
          ? `Imported ${count} options from ${file.name}`
          : `Imported ${count} hotkey combos from ${file.name}`,
      )
    } catch (cause) {
      setError(
        `Failed to import ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  // 允许直接把 config.json / hotkey.json 拖到对应 fieldset 上导入
  const [dragKind, setDragKind] = useState<'config' | 'hotkey' | null>(null)
  const dropHandlers = (kind: 'config' | 'hotkey') => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDragKind(kind)
    },
    onDragLeave: () => {
      setDragKind((current) => (current === kind ? null : current))
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDragKind(null)
      const file = event.dataTransfer?.files?.[0]
      if (file) void importFile(file, kind)
    },
  })

  return (
    <div className="pref-browser-cache">
      {message && <p className="pref-note">{message}</p>}
      {error && (
        <p className="pref-note">
          {tPlain('Error: ')}
          {error}
        </p>
      )}
      <fieldset
        className={`pref-section${dragKind === 'config' ? ' drag-over' : ''}`}
        {...dropHandlers('config')}
      >
        <legend>{tPlain('config.json — preferences')}</legend>
        <p className="pref-note">
          {tPlain(
            'All options (including defaults), compatible with the desktop Aegisub user config file.',
          )}
        </p>
        <div className="browser-cache-row">
          <span className="browser-cache-name">{tPlain('Export current preferences')}</span>
          <span className="dialog-spacer" />
          <button onClick={() => download('config.json', serializeConfigJson())}>
            {tPlain('Export…')}
          </button>
          <button onClick={() => configInputRef.current?.click()}>{tPlain('Import…')}</button>
          <input
            ref={configInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importFile(file, 'config')
            }}
          />
        </div>
      </fieldset>
      <fieldset
        className={`pref-section${dragKind === 'hotkey' ? ' drag-over' : ''}`}
        {...dropHandlers('hotkey')}
      >
        <legend>{tPlain('hotkey.json — hotkeys')}</legend>
        <p className="pref-note">
          {tPlain(
            'The complete hotkey table (replaces the current one on import), compatible with the desktop Aegisub hotkey file, including the pre-3.1 ',
          )}
          {'{'}modifiers,key{'}'}
          {tPlain(' format.')}
        </p>
        <div className="browser-cache-row">
          <span className="browser-cache-name">{tPlain('Export current hotkeys')}</span>
          <span className="dialog-spacer" />
          <button onClick={() => download('hotkey.json', serializeHotkeyJson())}>
            {tPlain('Export…')}
          </button>
          <button onClick={() => hotkeyInputRef.current?.click()}>{tPlain('Import…')}</button>
          <input
            ref={hotkeyInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importFile(file, 'hotkey')
            }}
          />
        </div>
      </fieldset>
    </div>
  )
}

function BrowserCachePage() {
  const [snapshot, setSnapshot] = useState<{
    usage: number | null
    quota: number | null
    databases: DatabaseInfo[]
    cacheNames: string[]
    local: StorageAreaInfo
    session: StorageAreaInfo
    keyframes: { count: number; bytes: number }
  } | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null
      const databases = await listDatabases()
      const cacheNames = typeof caches !== 'undefined' ? await caches.keys() : []
      const keyframes = await keyframeCacheStats()
      setSnapshot({
        usage: estimate?.usage ?? null,
        quota: estimate?.quota ?? null,
        databases,
        cacheNames,
        local: inspectStorageArea(localStorage),
        session: inspectStorageArea(sessionStorage),
        keyframes,
      })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 数据加载 effect：所有 setState 都发生在 await 之后，非同步级联渲染
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh()
  }, [refresh])

  const deleteDatabase = (name: string) => {
    if (!window.confirm(`Delete IndexedDB database "${name}"? This cannot be undone.`)) return
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => void refresh()
    request.onerror = () => void refresh()
    request.onblocked = () => void refresh() // 应用仍持有连接：关闭页面后生效
  }

  const deleteCache = async (name: string) => {
    await caches.delete(name)
    void refresh()
  }

  const clearStorageKey = (area: Storage, key: string) => {
    area.removeItem(key)
    void refresh()
  }

  const clearKeyframes = async () => {
    await clearKeyframeCache()
    void refresh()
  }

  const localFontsSupported = 'queryLocalFonts' in window

  const storageAreaSection = (title: string, area: Storage, info: StorageAreaInfo) => (
    <fieldset className="pref-section" key={title}>
      <legend>
        {title} — {formatBytes(info.total)}
      </legend>
      {info.entries.length === 0 ? (
        <p className="pref-note">{tPlain('Empty.')}</p>
      ) : (
        info.entries.map((entry) => (
          <div className="browser-cache-row" key={`${title}-${entry.key}`}>
            <code className="browser-cache-name">{entry.key}</code>
            <span className="browser-cache-size">{formatBytes(entry.bytes)}</span>
            <button onClick={() => clearStorageKey(area, entry.key)}>{tPlain('Clear')}</button>
          </div>
        ))
      )}
    </fieldset>
  )

  return (
    <div className="pref-browser-cache">
      {error && (
        <p className="pref-note">
          {tPlain('Failed to inspect storage: ')}
          {error}
        </p>
      )}
      <fieldset className="pref-section">
        <legend>{tPlain('Origin quota')}</legend>
        <p className="pref-note">
          {snapshot
            ? `Used ${formatBytes(snapshot.usage ?? 0)} of ${formatBytes(snapshot.quota ?? 0)} (browser-managed quota for this origin).`
            : tPlain('Measuring…')}
        </p>
        <p className="pref-note">
          {tPlain('Local Font Access: ')}
          {localFontsSupported ? tPlain('available') : tPlain('unavailable')}
          {tPlain(
            '. Imported font files are cached in the IndexedDB database "aegisub-web" (fonts store).',
          )}
        </p>
      </fieldset>
      <fieldset className="pref-section">
        <legend>{tPlain('IndexedDB')}</legend>
        {!snapshot ? (
          <p className="pref-note">{tPlain('Measuring…')}</p>
        ) : snapshot.databases.length === 0 ? (
          <p className="pref-note">{tPlain('No databases.')}</p>
        ) : (
          snapshot.databases.map((database) => (
            <div className="browser-cache-db" key={database.name}>
              <div className="browser-cache-row">
                <code className="browser-cache-name">
                  {database.name} (v{database.version})
                </code>
                <span className="dialog-spacer" />
                <button onClick={() => deleteDatabase(database.name)}>{tPlain('Delete')}</button>
              </div>
              {database.stores.map((store) => (
                <div className="browser-cache-row browser-cache-row-sub" key={store.name}>
                  <code className="browser-cache-name">{store.name}</code>
                  <span className="browser-cache-size">
                    {store.count} entries — {formatBytes(store.bytes)}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </fieldset>
      <fieldset className="pref-section">
        <legend>{tPlain('Keyframe cache')}</legend>
        <p className="pref-note">
          {tPlain(
            'Cached keyframe lists (per video file), evicted by Provider/FFmpegSource/Cache/Files and Cache/Size like the desktop ffindex cache.',
          )}
        </p>
        <div className="browser-cache-row">
          <code className="browser-cache-name">keyframes</code>
          <span className="browser-cache-size">
            {snapshot
              ? `${snapshot.keyframes.count} entries — ${formatBytes(snapshot.keyframes.bytes)}`
              : tPlain('Measuring…')}
          </span>
          <span className="dialog-spacer" />
          <button
            disabled={!snapshot || snapshot.keyframes.count === 0}
            onClick={() => void clearKeyframes()}
          >
            {tPlain('Clear')}
          </button>
        </div>
      </fieldset>
      <fieldset className="pref-section">
        <legend>{tPlain('Cache storage')}</legend>
        {!snapshot || snapshot.cacheNames.length === 0 ? (
          <p className="pref-note">{snapshot ? tPlain('No caches.') : tPlain('Measuring…')}</p>
        ) : (
          snapshot.cacheNames.map((name) => (
            <div className="browser-cache-row" key={name}>
              <code className="browser-cache-name">{name}</code>
              <span className="dialog-spacer" />
              <button onClick={() => void deleteCache(name)}>{tPlain('Delete')}</button>
            </div>
          ))
        )}
      </fieldset>
      {snapshot && storageAreaSection('localStorage', localStorage, snapshot.local)}
      {snapshot && storageAreaSection('sessionStorage', sessionStorage, snapshot.session)}
    </div>
  )
}
