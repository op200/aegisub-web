export type ShortcutContext =
  | 'Always'
  | 'Default'
  | 'Subtitle Grid'
  | 'Subtitle Edit Box'
  | 'Video'
  | 'Audio'
  | 'Styling Assistant'
  | 'Translation Assistant';

import { aegisubCommandForShortcut, aegisubPrimaryShortcut } from './aegisubHotkeys';

export interface CommandInfo {
  label: string;
  shortcuts?: Partial<Record<ShortcutContext, string[]>>;
}

export interface SubmenuDefinition {
  id: string;
  label: string;
  items: MenuItemDefinition[];
}

export interface MenuItemDefinition {
  command?: string;
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  submenu?: SubmenuDefinition;
}

export interface MenuDefinition {
  id: string;
  label: string;
  accessKey: string;
  items: MenuItemDefinition[];
}

export const COMMANDS: Record<string, CommandInfo> = {
  'subtitle/new': { label: 'New Subtitles', shortcuts: { Default: ['Ctrl-N'] } },
  'subtitle/open': { label: 'Open Subtitles...', shortcuts: { Default: ['Ctrl-O'] } },
  'subtitle/open/video': { label: 'Open Subtitles from Video' },
  'subtitle/save': { label: 'Save Subtitles', shortcuts: { Default: ['Ctrl-S', 'F2'] } },
  'subtitle/save/as': { label: 'Save Subtitles as...', shortcuts: { Default: ['Ctrl-Shift-S'] } },
  'tool/export': { label: 'Export Subtitles...' },
  'subtitle/properties': { label: 'Properties...' },
  'subtitle/attachment': { label: 'Attachments...' },
  'tool/font_collector': { label: 'Fonts Collector...' },
  'app/exit': { label: 'Exit', shortcuts: { Default: ['Ctrl-Q'] } },
  'edit/undo': { label: 'Undo', shortcuts: { Default: ['Ctrl-Z'] } },
  'edit/redo': { label: 'Redo', shortcuts: { Default: ['Ctrl-Y'] } },
  'edit/line/cut': { label: 'Cut Lines', shortcuts: { Default: ['Ctrl-X'] } },
  'edit/line/copy': { label: 'Copy Lines', shortcuts: { Default: ['Ctrl-C'] } },
  'edit/line/paste': { label: 'Paste Lines', shortcuts: { Default: ['Ctrl-V'] } },
  'edit/line/paste/over': { label: 'Paste Lines Over...', shortcuts: { Default: ['Ctrl-Shift-V'] } },
  'subtitle/find': { label: 'Find...', shortcuts: { Default: ['Ctrl-F'] } },
  'subtitle/find/next': { label: 'Find Next', shortcuts: { Default: ['F3'] } },
  'edit/find_replace': { label: 'Find and Replace...', shortcuts: { Default: ['Ctrl-H'] } },
  'tool/style/manager': { label: 'Styles Manager...' },
  'tool/style/assistant': { label: 'Styling Assistant...' },
  'tool/translation_assistant': { label: 'Translation Assistant...' },
  'tool/resampleres': { label: 'Resample Resolution...' },
  'subtitle/spellcheck': { label: 'Spell Checker...' },
  'subtitle/insert/before': { label: 'Insert Line Before' },
  'subtitle/insert/after': { label: 'Insert Line After' },
  'subtitle/insert/before/videotime': { label: 'Insert at Video Time Before' },
  'subtitle/insert/after/videotime': { label: 'Insert at Video Time After' },
  'edit/line/duplicate': { label: 'Duplicate Lines' },
  'edit/line/split/before': { label: 'Split Lines Before Current Frame', shortcuts: { Default: ['Ctrl-D'] } },
  'edit/line/split/after': { label: 'Split Lines After Current Frame', shortcuts: { Default: ['Ctrl-Shift-D'] } },
  'edit/line/delete': { label: 'Delete Lines', shortcuts: { Default: ['Ctrl-Delete'] } },
  'grid/sort/start': { label: 'Sort All Lines by Start Time' },
  'grid/move/up': { label: 'Move Lines Up', shortcuts: { Default: ['Alt-Up'] } },
  'grid/move/down': { label: 'Move Lines Down', shortcuts: { Default: ['Alt-Down'] } },
  'subtitle/select/all': { label: 'Select All', shortcuts: { 'Subtitle Grid': ['Ctrl-A'] } },
  'grid/line/next': {
    label: 'Next Line',
    shortcuts: { Default: ['Ctrl-KP_2'], 'Styling Assistant': ['PageDown'], 'Translation Assistant': ['PageDown'] },
  },
  'grid/line/next/create': {
    label: 'Next Line',
    shortcuts: { 'Subtitle Edit Box': ['Enter', 'KP_Enter'] },
  },
  'grid/line/prev': {
    label: 'Previous Line',
    shortcuts: { Default: ['Ctrl-KP_8'], 'Styling Assistant': ['PageUp'], 'Translation Assistant': ['PageUp'] },
  },
  'time/shift': { label: 'Shift Times...', shortcuts: { Default: ['Ctrl-I'] } },
  'time/snap/start_video': { label: 'Snap Start to Video', shortcuts: { Default: ['Ctrl-3'] } },
  'time/snap/end_video': { label: 'Snap End to Video', shortcuts: { Default: ['Ctrl-4'] } },
  'time/snap/scene': { label: 'Snap to Scene', shortcuts: { Default: ['Ctrl-5'] } },
  'time/frame/current': { label: 'Shift to Current Frame', shortcuts: { Default: ['Ctrl-6'] } },
  'video/open': { label: 'Open Video...' },
  'video/close': { label: 'Close Video' },
  'video/details': { label: 'Video Details...' },
  'video/jump': { label: 'Jump to...', shortcuts: { Default: ['Ctrl-G'] } },
  'video/jump/start': { label: 'Jump Video to Start', shortcuts: { Default: ['Ctrl-1'] } },
  'video/jump/end': { label: 'Jump Video to End', shortcuts: { Default: ['Ctrl-2'] } },
  'video/play': { label: 'Play Video', shortcuts: { Default: ['Ctrl-P'] } },
  'video/play/line': { label: 'Play Current Line' },
  'video/stop': { label: 'Stop Video' },
  'video/frame/prev': {
    label: 'Previous Frame',
    shortcuts: { Default: ['Ctrl-KP_4'], Video: ['Left'], 'Subtitle Grid': ['Left'] },
  },
  'video/frame/next': {
    label: 'Next Frame',
    shortcuts: { Default: ['Ctrl-KP_6'], Video: ['Right'], 'Subtitle Grid': ['Right'] },
  },
  'video/frame/prev/keyframe': {
    label: 'Previous Keyframe',
    shortcuts: { Video: ['Shift-Left'], 'Subtitle Grid': ['Shift-Left'] },
  },
  'video/frame/next/keyframe': {
    label: 'Next Keyframe',
    shortcuts: { Video: ['Shift-Right'], 'Subtitle Grid': ['Shift-Right'] },
  },
  'video/frame/prev/boundary': {
    label: 'Previous Subtitle Boundary',
    shortcuts: { Video: ['Ctrl-Left'], 'Subtitle Grid': ['Ctrl-Left'] },
  },
  'video/frame/next/boundary': {
    label: 'Next Subtitle Boundary',
    shortcuts: { Video: ['Ctrl-Right'], 'Subtitle Grid': ['Ctrl-Right'] },
  },
  'video/frame/prev/large': {
    label: 'Back One Second',
    shortcuts: { Video: ['Alt-Left'], 'Subtitle Grid': ['Alt-Left'] },
  },
  'video/frame/next/large': {
    label: 'Forward One Second',
    shortcuts: { Video: ['Alt-Right'], 'Subtitle Grid': ['Alt-Right'] },
  },
  'video/focus_seek': { label: 'Focus Video Position', shortcuts: { Default: ['Ctrl-Space'] } },
  'video/zoom/in': { label: 'Zoom In', shortcuts: { Default: ['Ctrl-KP_Add'] } },
  'video/zoom/out': { label: 'Zoom Out', shortcuts: { Default: ['Ctrl-KP_Subtract'] } },
  'video/tool/cross': { label: 'Standard Visual Tool', shortcuts: { Video: ['A'] } },
  'video/tool/drag': { label: 'Drag Visual Tool', shortcuts: { Video: ['S'] } },
  'video/tool/rotate/z': { label: 'Rotate Z Visual Tool', shortcuts: { Video: ['D'] } },
  'video/tool/rotate/xy': { label: 'Rotate XY Visual Tool', shortcuts: { Video: ['F'] } },
  'video/tool/scale': { label: 'Scale Visual Tool', shortcuts: { Video: ['G'] } },
  'video/tool/clip': { label: 'Rectangular Clip Tool', shortcuts: { Video: ['H'] } },
  'video/tool/vector_clip': { label: 'Vector Clip Tool', shortcuts: { Video: ['J'] } },
  'audio/open': { label: 'Open Audio File...' },
  'audio/open/video': { label: 'Open Audio from Video' },
  'audio/close': { label: 'Close Audio' },
  'audio/view/spectrum': { label: 'Spectrum Display' },
  'audio/view/waveform': { label: 'Waveform Display' },
  'audio/commit': {
    label: 'Commit',
    shortcuts: { Always: ['KP_Enter'], Audio: ['Enter', 'G'], 'Subtitle Edit Box': ['Enter'] },
  },
  'audio/commit/default': { label: 'Commit and Stay', shortcuts: { Audio: ['Shift-G'] } },
  'audio/play/selection': {
    label: 'Play Selection',
    shortcuts: { Always: ['KP_5'], Audio: ['S', 'Space'] },
  },
  'audio/play/line': { label: 'Play Current Line', shortcuts: { Audio: ['R'] } },
  'audio/play/selection/before': {
    label: 'Play Before Selection',
    shortcuts: { Always: ['KP_1'], Audio: ['Q'] },
  },
  'audio/play/selection/after': {
    label: 'Play After Selection',
    shortcuts: { Always: ['KP_3'], Audio: ['W'] },
  },
  'audio/play/selection/begin': { label: 'Play Selection Beginning', shortcuts: { Audio: ['E'] } },
  'audio/play/selection/end': { label: 'Play Selection End', shortcuts: { Audio: ['D'] } },
  'audio/play/to_end': { label: 'Play to End', shortcuts: { Audio: ['T'] } },
  'audio/play/toggle': { label: 'Toggle Playback', shortcuts: { Audio: ['B'] } },
  'audio/scroll/left': { label: 'Scroll Audio Left', shortcuts: { Audio: ['A'] } },
  'audio/scroll/right': { label: 'Scroll Audio Right', shortcuts: { Audio: ['F'] } },
  'audio/stop': { label: 'Stop', shortcuts: { Always: ['KP_8'], Audio: ['H'] } },
  'time/prev': { label: 'Previous Line', shortcuts: { Always: ['KP_0'], Audio: ['Left', 'Z'] } },
  'time/next': { label: 'Next Line', shortcuts: { Always: ['KP_2'], Audio: ['Right', 'X'] } },
  'time/lead/in': { label: 'Add Lead In', shortcuts: { Audio: ['C'] } },
  'time/lead/out': { label: 'Add Lead Out', shortcuts: { Audio: ['V'] } },
  'time/start/decrease': { label: 'Move Start Back', shortcuts: { Always: ['KP_4'] } },
  'time/start/increase': { label: 'Move Start Forward', shortcuts: { Always: ['KP_6'] } },
  'time/length/decrease': {
    label: 'Decrease Duration',
    shortcuts: { Always: ['KP_7'], Audio: ['KP_Subtract'] },
  },
  'time/length/increase': {
    label: 'Increase Duration',
    shortcuts: { Always: ['KP_9'], Audio: ['KP_Add'] },
  },
  'edit/color/primary': { label: 'Primary Color', shortcuts: { 'Subtitle Edit Box': ['Alt-1'] } },
  'edit/color/secondary': { label: 'Secondary Color', shortcuts: { 'Subtitle Edit Box': ['Alt-2'] } },
  'edit/color/outline': { label: 'Outline Color', shortcuts: { 'Subtitle Edit Box': ['Alt-3'] } },
  'edit/color/shadow': { label: 'Shadow Color', shortcuts: { 'Subtitle Edit Box': ['Alt-4'] } },
  'app/display/subs': { label: 'Show Subtitles Only' },
  'app/display/video_subs': { label: 'Show Video and Subtitles' },
  'app/display/audio_subs': { label: 'Show Audio and Subtitles' },
  'app/display/full': { label: 'Show Everything' },
  'app/toggle/toolbar': { label: 'Toolbar' },
  'app/options': { label: 'Options...', shortcuts: { Default: ['Alt-O'] } },
  'help/contents': { label: 'Contents', shortcuts: { Default: ['F1'] } },
  'help/website': { label: 'Aegisub Website' },
  'help/bugs': { label: 'Report a Bug' },
  'app/about': { label: 'About Aegisub Web' },
  // ---- 以下为 Aegisub 菜单/工具栏中引用的命令（数据驱动 UI）----
  'subtitle/open/charset': { label: 'Open Subtitles with Charset...' },
  'subtitle/open/autosave': { label: 'Recover Autosave' },
  'subtitle/select/visible': { label: 'Select Visible Lines' },
  'app/new_window': { label: 'New Window' },
  'edit/line/recombine': { label: 'Recombine Lines' },
  'edit/line/split/by_karaoke': { label: 'Split by Karaoke' },
  'edit/line/join/concatenate': { label: 'Join (concatenate)' },
  'edit/line/join/keep_first': { label: 'Join (keep first)' },
  'edit/line/join/as_karaoke': { label: 'Join (as karaoke)' },
  'grid/swap': { label: 'Swap Lines' },
  'tool/line/select': { label: 'Select Lines...' },
  'grid/sort/end': { label: 'Sort All Lines by End Time' },
  'grid/sort/style': { label: 'Sort All Lines by Style' },
  'grid/sort/actor': { label: 'Sort All Lines by Actor' },
  'grid/sort/effect': { label: 'Sort All Lines by Effect' },
  'grid/sort/layer': { label: 'Sort All Lines by Layer' },
  'grid/sort/start/selected': { label: 'Sort Selected Lines by Start Time' },
  'grid/sort/end/selected': { label: 'Sort Selected Lines by End Time' },
  'grid/sort/style/selected': { label: 'Sort Selected Lines by Style' },
  'grid/sort/actor/selected': { label: 'Sort Selected Lines by Actor' },
  'grid/sort/effect/selected': { label: 'Sort Selected Lines by Effect' },
  'grid/sort/layer/selected': { label: 'Sort Selected Lines by Layer' },
  'grid/move/up/end': { label: 'Move Lines to Top' },
  'grid/move/down/end': { label: 'Move Lines to Bottom' },
  'grid/tags/show': { label: 'Show Overrides' },
  'grid/tags/simplify': { label: 'Simplify Overrides' },
  'grid/tags/hide': { label: 'Hide Overrides' },
  'grid/tag/cycle_hiding': { label: 'Cycle Tag Hiding' },
  'tool/time/postprocess': { label: 'Timing Processor...' },
  'tool/time/kanji': { label: 'Kanji Timer...' },
  'time/continuous/start': { label: 'Make Times Continuous (Change Start)' },
  'time/continuous/end': { label: 'Make Times Continuous (Change End)' },
  'video/open/dummy': { label: 'Open Dummy Video...' },
  'video/detach': { label: 'Detach Video' },
  'video/show_overscan': { label: 'Show Overscan Margin' },
  'video/reset_pan': { label: 'Reset Panning' },
  'video/zoom/50': { label: 'Zoom 50%' },
  'video/zoom/100': { label: 'Zoom 100%' },
  'video/zoom/200': { label: 'Zoom 200%' },
  'video/aspect/default': { label: 'Default Aspect Ratio' },
  'video/aspect/full': { label: 'Full Aspect Ratio' },
  'video/aspect/wide': { label: 'Wide Aspect Ratio' },
  'video/aspect/cinematic': { label: 'Cinematic Aspect Ratio' },
  'video/aspect/custom': { label: 'Custom Aspect Ratio...' },
  'video/opt/autoscroll': { label: 'Auto Scroll' },
  'timecode/open': { label: 'Open Timecodes...' },
  'timecode/save': { label: 'Save Timecodes...' },
  'timecode/close': { label: 'Close Timecodes' },
  'keyframe/open': { label: 'Open Keyframes...' },
  'keyframe/save': { label: 'Save Keyframes...' },
  'keyframe/close': { label: 'Close Keyframes' },
  'audio/open/blank': { label: 'Open Blank Audio' },
  'audio/open/noise': { label: 'Open Noise Audio' },
  'audio/opt/autocommit': { label: 'Auto Commit' },
  'audio/opt/autonext': { label: 'Auto Next' },
  'audio/opt/autoscroll': { label: 'Auto Scroll' },
  'audio/opt/spectrum': { label: 'Spectrum Display' },
  'audio/opt/vertical_link': { label: 'Link Vertical Zoom' },
  'audio/karaoke': { label: 'Karaoke Mode' },
  'app/toggle/global_hotkeys': { label: 'Global Hotkeys' },
  'audio/go_to': { label: 'Go to Selection' },
  'app/language': { label: 'Language...' },
  'app/updates': { label: 'Check for Updates...' },
  'app/log': { label: 'View Log' },
  'help/irc': { label: 'IRC Channel' },
  'am/meta': { label: 'Automation Manager...' },
  'tool/kara_timing_copy': { label: 'Karaoke Timing Copier...' },
  'automation/again': { label: 'Repeat Last Automation' },
};

export function primaryShortcut(commandId: string): string {
  return aegisubPrimaryShortcut(commandId) || (COMMANDS[commandId]?.shortcuts?.Default?.[0] ?? '');
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string {
  const codeMap: Record<string, string> = {
    NumpadEnter: 'KP_Enter',
    NumpadAdd: 'KP_Add',
    NumpadSubtract: 'KP_Subtract',
    NumpadMultiply: 'KP_Multiply',
    NumpadDivide: 'KP_Divide',
    NumpadDecimal: 'KP_Decimal',
    Numpad0: 'KP_0',
    Numpad1: 'KP_1',
    Numpad2: 'KP_2',
    Numpad3: 'KP_3',
    Numpad4: 'KP_4',
    Numpad5: 'KP_5',
    Numpad6: 'KP_6',
    Numpad7: 'KP_7',
    Numpad8: 'KP_8',
    Numpad9: 'KP_9',
  };
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Backspace: 'Backspace',
    Escape: 'Escape',
    Delete: 'Delete',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  let key = codeMap[event.code] ?? keyMap[event.key] ?? event.key;
  if (key.length === 1) key = key.toUpperCase();
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return [...modifiers, key].join('-');
}

export function commandForShortcut(shortcut: string, context: ShortcutContext): string | null {
  return aegisubCommandForShortcut(shortcut, context, (fallbackShortcut, fallbackContext) => {
    const contexts: ShortcutContext[] = fallbackContext === 'Default' ? ['Default'] : [fallbackContext, 'Default'];
    for (const candidateContext of contexts) {
      for (const [id, info] of Object.entries(COMMANDS)) {
        if (info.shortcuts?.[candidateContext]?.includes(fallbackShortcut)) return id;
      }
    }
    return null;
  });
}
