/**
 * 偏好设置存储（对应 Aegisub libaegisub/option.cpp + config.json）。
 *
 * 默认值树完整取自 src/libresrc/default_config.json；选项按扁平路径读写
 * （OPT_GET/OPT_SET 语义），持久化到 IndexedDB（?user/config.json 对应物，
 * localStorage 为同步回退），类型系统与 agi::OptionType 一致
 * （bool/int/double/string/color/list-string）。
 * UI 层见 ui/components/PreferencesDialog.tsx（对应 preferences.cpp）。
 */
import { useSyncExternalStore } from 'react'

import { persistConfigJson } from '../storage/configStore'

export type OptionType = 'bool' | 'int' | 'double' | 'string' | 'color' | 'list-string'

/** default_config.json（Aegisub src/libresrc/default_config.json 原样子集） */
export const DEFAULT_CONFIG = {
  App: {
    Auto: {
      Backup: true,
      'Check For Updates': true,
      'Load Linked Files': 2,
      Save: true,
      'Save Every Seconds': 60,
      'Save on Every Change': false,
    },
    'Call Tips': false,
    'First Start': true,
    Language: '',
    Maximized: false,
    'Save Charset': 'UTF-8',
    'Save UI State': true,
    'Show Toolbar': true,
    'Toolbar Icon Size': 16,
  },
  Audio: {
    Auto: { Commit: false, Focus: false, Scroll: true },
    Cache: { HD: { Location: 'default' }, Type: 1 },
    'Colour Schemes': ['Green', 'Icy Blue'],
    'Display Height': 200,
    Display: {
      Draw: {
        'Cursor Time': true,
        'Inactive Comments': false,
        'Keyframes in Dialogue Mode': true,
        'Keyframes in Karaoke Mode': true,
        Seconds: true,
        'Video Position': true,
      },
      'Waveform Style': 0,
    },
    Downmixer: 'ConvertToMono',
    'Drag Timing': true,
    'Inactive Lines Display Mode': 3,
    Karaoke: { 'Font Face': 'Verdana', 'Font Size': 9 },
    Lead: { IN: 100, OUT: 350 },
    'Line Boundaries Thickness': 2,
    Link: true,
    'Lock Scroll on Cursor': false,
    'Medusa Timing Hotkeys': false,
    'Next Line on Commit': true,
    Player: '',
    'Plays When Stepping Video': false,
    Provider: 'ffmpegsource',
    Renderer: { Spectrum: { Cutoff: 0, 'Memory Max': 128, Quality: 1, FreqCurve: 0 } },
    Snap: { Distance: 8, Enable: true },
    Spectrum: true,
    'Start Drag Sensitivity': 8,
    'Track Cursor': { 'Font Face': '' },
    Volume: 50,
    'Wheel Default to Zoom': false,
    Zoom: { Horizontal: 0, Vertical: 50 },
  },
  Automation: { 'Autoreload Mode': 1, 'Trace Level': 3 },
  Colour: {
    'Audio Display': {
      Keyframe: 'rgb(255,0,255)',
      'Line Boundary Inactive Line': 'rgb(190,190,190)',
      'Line boundary End': 'rgb(0, 0, 216)',
      'Line boundary Start': 'rgb(216, 0, 0)',
      'Play Cursor': 'rgb(255,255,255)',
      'Current Frame Range': 'rgba(255,255,255,160)',
      'Previous Frame Range': 'rgba(255,255,255,200)',
      'Seconds Line': 'rgb(0,100,255)',
      Spectrum: 'Icy Blue',
      'Syllable Boundaries': 'rgb(255,255,0)',
      Waveform: 'Green',
    },
    Schemes: {
      Green: {
        Normal: {
          'Hue Offset': 85.0,
          'Hue Scale': 0.0,
          'Saturation Offset': 255.0,
          'Saturation Scale': 0.0,
          'Lightness Offset': 0.0,
          'Lightness Scale': 200.0,
        },
        Inactive: {
          'Hue Offset': 85.0,
          'Hue Scale': 0.0,
          'Saturation Offset': 255.0,
          'Saturation Scale': 0.0,
          'Lightness Offset': 0.0,
          'Lightness Scale': 100.0,
        },
        Selection: {
          'Hue Offset': 80.0,
          'Hue Scale': 0.0,
          'Saturation Offset': 255.0,
          'Saturation Scale': 0.0,
          'Lightness Offset': 10.0,
          'Lightness Scale': 175.0,
        },
        Primary: {
          'Hue Offset': 85.0,
          'Hue Scale': 0.0,
          'Saturation Offset': 128.0,
          'Saturation Scale': 0.0,
          'Lightness Offset': 25.0,
          'Lightness Scale': 300.0,
        },
        UI: { Light: 'rgb(0, 200, 0)', Dark: 'rgb(0, 10, 0)', Selection: 'rgb(0, 80, 0)' },
        'UI Focused': {
          Light: 'rgb(50, 255, 50)',
          Dark: 'rgb(0, 10, 0)',
          Selection: 'rgb(0, 80, 0)',
        },
      },
      'Icy Blue': {
        Normal: {
          'Hue Offset': 191.0,
          'Hue Scale': -128.0,
          'Saturation Offset': 127.0,
          'Saturation Scale': 128.0,
          'Lightness Offset': 0.0,
          'Lightness Scale': 255.0,
        },
        Inactive: {
          'Hue Offset': 191.0,
          'Hue Scale': -128.0,
          'Saturation Offset': 63.0,
          'Saturation Scale': 192.0,
          'Lightness Offset': 32.0,
          'Lightness Scale': 192.0,
        },
        Selection: {
          'Hue Offset': 191.0,
          'Hue Scale': -128.0,
          'Saturation Offset': 127.0,
          'Saturation Scale': 128.0,
          'Lightness Offset': 32.0,
          'Lightness Scale': 192.0,
        },
        Primary: {
          'Hue Offset': 191.0,
          'Hue Scale': -128.0,
          'Saturation Offset': 127.0,
          'Saturation Scale': 128.0,
          'Lightness Offset': 64.0,
          'Lightness Scale': 192.0,
        },
        UI: { Light: 'rgb(89, 145, 220)', Dark: 'rgb(8, 4, 13)', Selection: 'rgb(65, 34, 103)' },
        'UI Focused': {
          Light: 'rgb(205, 240, 226)',
          Dark: 'rgb(8, 4, 13)',
          Selection: 'rgb(82, 107, 213)',
        },
      },
    },
    'Style Editor': { Background: { Preview: 'rgb(125, 153, 176)' } },
    'Subtitle Grid': {
      'Active Border': 'rgb(255, 91, 239)',
      Background: {
        Background: 'rgb(255,255,255)',
        Comment: 'rgb(216, 222, 245)',
        Inframe: 'rgb(255, 253, 234)',
        'Selected Comment': 'rgb(211, 238, 238)',
        Selection: 'rgb(206, 255, 231)',
      },
      Collision: 'rgb(255,0,0)',
      'CPS Error': 'rgb(255,0,0)',
      Header: 'rgb(165, 207, 231)',
      'Left Column': 'rgb(196, 236, 201)',
      Lines: 'rgb(190,190,190)',
      Selection: 'rgb(0,0,0)',
      Standard: 'rgb(0,0,0)',
    },
    Subtitle: {
      Background: 'rgb(255, 255, 255)',
      Syntax: {
        Background: {
          Brackets: '',
          Comment: '',
          'Drawing Command': '',
          'Drawing X': '',
          'Drawing Y': '',
          Error: 'rgb(255, 200, 200)',
          'Karaoke Template': '',
          'Karaoke Variable': '',
          'Line Break': '',
          Normal: '',
          Parameters: '',
          Slashes: '',
          Tags: '',
        },
        Bold: {
          Brackets: false,
          Comment: true,
          'Drawing Command': true,
          'Drawing X': false,
          'Drawing Y': false,
          Error: false,
          'Karaoke Template': true,
          'Karaoke Variable': true,
          'Line Break': true,
          Normal: false,
          Parameters: false,
          Slashes: false,
          Tags: true,
        },
        Underline: { 'Drawing Endpoint': true },
        Brackets: 'rgb(20, 50, 255)',
        Comment: 'rgb(0,0,0)',
        'Drawing Command': 'rgb(0,0,0)',
        'Drawing X': 'rgb(90,40,40)',
        'Drawing Y': 'rgb(40,90,40)',
        Error: 'rgb(200, 0, 0)',
        'Karaoke Template': 'rgb(128, 0, 192)',
        'Karaoke Variable': 'rgb(128, 0, 192)',
        'Line Break': 'rgb(160, 160, 160)',
        Normal: 'rgb(0,0,0)',
        Parameters: 'rgb(40, 90, 40)',
        Slashes: 'rgb(255, 0, 200)',
        Tags: 'rgb(90, 90, 90)',
      },
    },
    'Video Dummy': { 'Last Colour': 'rgb(47, 163, 254)' },
    'Visual Tools': {
      'Highlight Primary': 'rgb(255, 169, 40)',
      'Highlight Secondary': 'rgb(255, 253, 185)',
      'Lines Primary': 'rgb(187, 0, 0)',
      'Lines Secondary': 'rgb(106, 32, 19)',
      'Shaded Area Alpha': 0.5,
    },
  },
  Limits: { 'Find Replace': 16, MRU: 16, 'Undo Levels': 50 },
  Path: {
    Auto: { Backup: '?user/autoback', Save: '?user/autosave' },
    Automation: {
      Autoload: '?user/automation/autoload/|?data/automation/autoload/',
      Base: '?data/automation/',
      Include: '?user/automation/include/|?data/automation/include/',
    },
    Dictionary: '?user/dictionaries',
    'Fonts Collector Destination': '?script',
    Last: { Audio: '', Automation: '', Keyframes: '', Subtitles: '', Timecodes: '', Video: '' },
    Screenshot: '?video',
  },
  Provider: {
    Audio: { FFmpegSource: { 'Decode Error Handling': 'ignore' } },
    FFmpegSource: {
      Cache: { Files: 20, Size: 42 },
      'Index All Tracks': true,
      'Log Level': 'quiet',
    },
    Video: {
      Cache: { Size: 32 },
      FFmpegSource: { 'Decoding Threads': -1, 'Unsafe Seeking': false },
    },
  },
  Subtitle: {
    'Character Counter': {
      'Ignore Whitespace': true,
      'Ignore Punctuation': true,
      'CPS Warning Threshold': 15,
      'CPS Error Threshold': 30,
    },
    'Character Limit': 40,
    'Default Resolution': { Auto: true, Height: 720, Width: 1280 },
    'Edit Box': { 'Soft Line Break': false, 'Font Face': '', 'Font Size': 10 },
    Grid: {
      Column: [true],
      'Focus Allow': true,
      'Font Face': '',
      'Font Size': 9,
      'Hide Overrides': 1,
      'Hide Overrides Char': '☀',
      'Highlight Subtitles in Frame': true,
    },
    Highlight: { Syntax: true },
    // Web 版偏离上游：'jassub'（libass WASM 渲染）| 'canvas'（内置 drawCue 兜底）；
    // 上游历史值 'libass'/'csri' 合并时一并视为 jassub
    Provider: 'jassub',
    'Show Original': false,
    'Time Edit': { 'Insert Mode': true },
  },
  'Subtitle Format': {
    ASS: { 'Default Style Catalog': 'Default' },
    MicroDVD: { 'Default Style Catalog': 'Default' },
    SRT: { 'Default Style Catalog': 'Default' },
    TTXT: { 'Default Style Catalog': 'Default' },
    TXT: { 'Default Style Catalog': 'Default' },
  },
  Timing: { 'Default Duration': 3000 },
  Tool: {
    Preferences: { Page: 0 },
    'Style Editor': {
      Last: { Height: -1, Width: -1, X: -1, Y: -1 },
      Maximized: false,
      'Preview Text': 'Aegisub\\N0123 日本語',
    },
    'Select Lines': {
      Action: 0,
      Condition: 0,
      Field: 0,
      Match: { Case: false, Comment: false, Dialogue: true },
      Mode: 1,
      Text: '',
    },
    'Shift Times': { Affect: 0, ByTime: true, Direction: true, Frames: 0, Time: 0, Type: 0 },
    'Timing Post Processor': {
      'Adjacent Bias': 0.9,
      Enable: { Adjacent: true, Keyframe: true, Lead: { IN: true, OUT: true } },
      'Only Selection': false,
      Lead: { IN: 100, OUT: 350 },
      Threshold: {
        'Adjacent Gap': 300,
        'Adjacent Overlap': 50,
        'Key End After': 250,
        'Key End Before': 200,
        'Key Start After': 150,
        'Key Start Before': 200,
      },
    },
    'Translation Assistant': { 'Skip Whitespace': true },
    Visual: {
      // video/tool/perspective（fork feature 分支）：Outer=显示环绕平面、
      // Outer Locked=锁定外框、Grid=3D 网格，Org Mode 取 PERSP_ORGMODE_* 位值
      // （0=center、16=no-\fax、32=keep）
      Perspective: { Outer: false, 'Outer Locked': false, Grid: false, 'Org Mode': 0 },
      // 特征柄命中半径（visual_feature.cpp：DRAG_SMALL_CIRCLE 判定 3*size）
      'Shape Handle Size': 3,
      Autohide: false,
    },
  },
  Version: { 'Last Version': 4040, 'Next Check': 0 },
  Video: {
    'Default Zoom': 7,
    'Scroll Action': 0,
    'Ctrl Scroll Action': 2,
    'Shift Scroll Action': 4,
    Detached: { Enabled: false, Last: { X: -1, Y: -1 }, Maximized: false },
    Dummy: {
      'FPS String': '24000/1001',
      Last: { Height: 720, Length: 40000, Width: 1280 },
      Pattern: false,
    },
    'PlayRes Mismatch': 0,
    'Untagged Matrix Warning': true,
    'HDR Video Warning': true,
    'No YCbCr Matrix in Script': 1,
    'YCbCr Matrix Mismatch': 1,
    'No LayoutRes in Script': 1,
    'LayoutRes Mismatch': 1,
    'Open Audio': true,
    'Overscan Mask': false,
    Provider: 'ffmpegsource',
    Slider: { 'Fast Jump Step': 10, 'Show Keyframes': true },
    'Subtitle Sync': true,
  },
} as const

/** 颜色类选项（default_config.json 中以颜色字符串存储的项；Scheme 名称字符串除外） */
const COLOR_OPTIONS = new Set<string>([
  'Colour/Audio Display/Keyframe',
  'Colour/Audio Display/Line Boundary Inactive Line',
  'Colour/Audio Display/Line boundary End',
  'Colour/Audio Display/Line boundary Start',
  'Colour/Audio Display/Play Cursor',
  'Colour/Audio Display/Current Frame Range',
  'Colour/Audio Display/Previous Frame Range',
  'Colour/Audio Display/Seconds Line',
  'Colour/Audio Display/Syllable Boundaries',
  'Colour/Style Editor/Background/Preview',
  'Colour/Subtitle Grid/Active Border',
  'Colour/Subtitle Grid/Background/Background',
  'Colour/Subtitle Grid/Background/Comment',
  'Colour/Subtitle Grid/Background/Inframe',
  'Colour/Subtitle Grid/Background/Selected Comment',
  'Colour/Subtitle Grid/Background/Selection',
  'Colour/Subtitle Grid/Collision',
  'Colour/Subtitle Grid/CPS Error',
  'Colour/Subtitle Grid/Header',
  'Colour/Subtitle Grid/Left Column',
  'Colour/Subtitle Grid/Lines',
  'Colour/Subtitle Grid/Selection',
  'Colour/Subtitle Grid/Standard',
  'Colour/Subtitle/Background',
  'Colour/Subtitle/Syntax/Background/Error',
  'Colour/Subtitle/Syntax/Brackets',
  'Colour/Subtitle/Syntax/Comment',
  'Colour/Subtitle/Syntax/Drawing Command',
  'Colour/Subtitle/Syntax/Drawing X',
  'Colour/Subtitle/Syntax/Drawing Y',
  'Colour/Subtitle/Syntax/Error',
  'Colour/Subtitle/Syntax/Karaoke Template',
  'Colour/Subtitle/Syntax/Karaoke Variable',
  'Colour/Subtitle/Syntax/Line Break',
  'Colour/Subtitle/Syntax/Normal',
  'Colour/Subtitle/Syntax/Parameters',
  'Colour/Subtitle/Syntax/Slashes',
  'Colour/Subtitle/Syntax/Tags',
  'Colour/Video Dummy/Last Colour',
  'Colour/Visual Tools/Highlight Primary',
  'Colour/Visual Tools/Highlight Secondary',
  'Colour/Visual Tools/Lines Primary',
  'Colour/Visual Tools/Lines Secondary',
])

const LIST_STRING_OPTIONS = new Set<string>(['Audio/Colour Schemes', 'Subtitle/Grid/Column'])

/** 扁平化默认值：路径 → 值（agi::Options 的 from_json 展开语义） */
function flatten(tree: unknown, prefix: string, out: Map<string, unknown>): void {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}/${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      flatten(value, name, out)
    else out.set(name, Array.isArray(value) ? [...value] : value)
  }
}

const defaults = new Map<string, unknown>()
flatten(DEFAULT_CONFIG, '', defaults)

const STORAGE_KEY = 'aegisub-web:config'

function detectType(name: string, value: unknown): OptionType {
  if (COLOR_OPTIONS.has(name)) return 'color'
  if (LIST_STRING_OPTIONS.has(name)) return 'list-string'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double'
  return 'string'
}

const types = new Map<string, OptionType>()
for (const [name, value] of defaults) types.set(name, detectType(name, value))

function readStoredTree(): Record<string, unknown> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 当前值（模块加载时从 localStorage 恢复，IndexedDB 持久化树随后由启动引导覆盖） */
const values = new Map(defaults)

function collectLeaves(tree: unknown, prefix: string, out: Map<string, unknown>): void {
  if (tree === null || typeof tree !== 'object') return
  if (Array.isArray(tree) || typeof tree !== 'object') {
    out.set(prefix, tree)
    return
  }
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}/${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      collectLeaves(value, name, out)
    else out.set(name, Array.isArray(value) ? [...value] : value)
  }
}

/**
 * 合并持久化树到当前值（config.json 加载语义：仅接受默认树中存在且类型兼容的项，
 * 未知项/类型不符项静默跳过）。返回实际应用的选项数。
 */
export function applyConfigTree(tree: unknown): number {
  const stored = new Map<string, unknown>()
  collectLeaves(tree, '', stored)
  let applied = 0
  for (const [name, value] of stored) {
    const type = types.get(name)
    if (!type) continue
    if (type === 'bool' && typeof value === 'boolean') values.set(name, value)
    else if (type === 'int' && typeof value === 'number' && Number.isInteger(value))
      values.set(name, value)
    else if (type === 'double' && typeof value === 'number') values.set(name, value)
    else if (type === 'string' && typeof value === 'string') values.set(name, value)
    else if (type === 'color' && typeof value === 'string') values.set(name, value)
    else if (type === 'list-string' && Array.isArray(value)) values.set(name, [...value])
    else continue
    applied += 1
  }
  return applied
}

{
  applyConfigTree(readStoredTree())
}

/** 当前值构建持久化树（Options::Flush 的 put_option 语义，含全部默认值） */
function buildConfigTree(): Record<string, unknown> {
  const tree: Record<string, unknown> = {}
  for (const [name, value] of values) {
    const parts = name.split('/')
    let node = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return tree
}

/** list-string 项转为源码 config.json 的类型化数组（[{"string": "..."}]） */
function toSourceTree(tree: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}/${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = toSourceTree(value as Record<string, unknown>, name)
    } else if (getOptionType(name) === 'list-string') {
      out[key] = (value as unknown[]).map((item) => ({ string: item }))
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 源码 config.json → web 树：类型化数组 [{"string": "x"}] 还原为普通数组
 * （option.cpp ConfigVisitor::Visit(json::Array) 的展开语义）。
 */
function fromSourceTree(tree: unknown): Record<string, unknown> {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tree)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = fromSourceTree(value)
    } else if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(item).length === 1,
      )
    ) {
      out[key] = value.map((item) => Object.values(item as Record<string, unknown>)[0])
    } else {
      out[key] = value
    }
  }
  return out
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildConfigTree()))
  } catch {
    // localStorage 不可用（隐私模式/测试环境）时仅内存生效
  }
  // IndexedDB 持久化（config.json 对应物），失败静默降级
  void persistConfigJson(buildConfigTree())
}

// ---------------------------------------------------------------------------
// config.json 导入导出（与 Aegisub 桌面版 ?user/config.json 互相兼容）
// ---------------------------------------------------------------------------
/** 导出为源码 config.json 格式（含全部选项默认值，Options::Flush 语义） */
export function serializeConfigJson(): string {
  return `${JSON.stringify(toSourceTree(buildConfigTree()), null, 2)}\n`
}

/** 导入 config.json（源码版或 web 版导出均可），返回应用的选项数 */
export function importConfigJson(text: string): number {
  const parsed = fromSourceTree(JSON.parse(text))
  const applied = applyConfigTree(parsed)
  if (applied > 0) persist()
  return applied
}

// ---------------------------------------------------------------------------
// 订阅（OPT_SET 后通知 React 重渲染）
// ---------------------------------------------------------------------------
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** React 订阅：任何选项提交后版本号 +1，触发依赖组件重渲染 */
export function useOptionsVersion(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => version,
    () => version,
  )
}

/** 非选项类配置（热键覆盖等）提交后同步通知 UI */
export function notifyOptionsChanged(): void {
  notify()
}

// ---------------------------------------------------------------------------
// OPT_GET / OPT_SET
// ---------------------------------------------------------------------------
export function getOptionType(name: string): OptionType {
  const type = types.get(name)
  if (!type) throw new Error(`Unknown option: ${name}`)
  return type
}

export function getOption<T = unknown>(name: string): T {
  const value = values.get(name)
  if (value === undefined) throw new Error(`Unknown option: ${name}`)
  return value as T
}

export function getOptionBool(name: string): boolean {
  return getOption<boolean>(name)
}
export function getOptionInt(name: string): number {
  return getOption<number>(name)
}
export function getOptionDouble(name: string): number {
  return getOption<number>(name)
}
export function getOptionString(name: string): string {
  return getOption<string>(name)
}

export function isOptionDefault(name: string): boolean {
  if (!defaults.has(name)) throw new Error(`Unknown option: ${name}`)
  return JSON.stringify(values.get(name)) === JSON.stringify(defaults.get(name))
}

/** OPT_SET：写值 + 持久化 + 通知 */
export function setOption(name: string, value: unknown): void {
  const type = types.get(name)
  if (!type) throw new Error(`Unknown option: ${name}`)
  const valid =
    (type === 'bool' && typeof value === 'boolean') ||
    (type === 'int' && typeof value === 'number' && Number.isInteger(value)) ||
    (type === 'double' && typeof value === 'number' && Number.isFinite(value)) ||
    ((type === 'string' || type === 'color') && typeof value === 'string') ||
    (type === 'list-string' && Array.isArray(value))
  if (!valid) throw new Error(`Type mismatch for option ${name}: ${type}`)
  const normalized = type === 'list-string' ? [...(value as unknown[])] : value
  if (JSON.stringify(values.get(name)) === JSON.stringify(normalized)) return
  values.set(name, normalized)
  persist()
  notify()
}

/** 恢复单个选项默认值（OptionValue::Reset） */
export function resetOption(name: string): void {
  if (!defaults.has(name)) throw new Error(`Unknown option: ${name}`)
  values.set(name, defaults.get(name))
  persist()
  notify()
}

/** 恢复一组选项默认值（Preferences::OnResetDefault） */
export function resetOptions(names: Iterable<string>): void {
  let changed = false
  for (const name of names) {
    if (!defaults.has(name)) continue
    if (JSON.stringify(values.get(name)) !== JSON.stringify(defaults.get(name))) {
      values.set(name, defaults.get(name))
      changed = true
    }
  }
  if (changed) {
    persist()
    notify()
  }
}

export function optionNames(): string[] {
  return [...defaults.keys()]
}
