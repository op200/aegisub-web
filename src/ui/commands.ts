export type ShortcutContext =
  | 'Always'
  | 'Default'
  | 'Main Frame'
  | 'Subtitle Grid'
  | 'Subtitle Edit Box'
  | 'Video'
  | 'Audio'
  | 'Styling Assistant'
  | 'Translation Assistant'

import {
  aegisubCommandForShortcut,
  aegisubPrimaryShortcut,
  getActiveHotkeys,
  shortcutContextChain,
} from './aegisubHotkeys'
import { tPlain } from './i18n'

export interface CommandInfo {
  /** 菜单显示文本 = Aegisub StrMenu（去掉 & 加速键） */
  label: string
  /** 工具栏/按钮 tooltip = Aegisub StrHelp */
  help?: string
  shortcuts?: Partial<Record<ShortcutContext, string[]>>
}

export interface SubmenuDefinition {
  id: string
  label: string
  items: MenuItemDefinition[]
}

export interface MenuItemDefinition {
  command?: string
  label?: string
  separator?: boolean
  disabled?: boolean
  submenu?: SubmenuDefinition
  /** MRU 子菜单（menu.cpp AddRecent）：MenuBar 按最近文件列表动态渲染 */
  recent?: string
}

export interface MenuDefinition {
  id: string
  label: string
  accessKey: string
  items: MenuItemDefinition[]
}

export const COMMANDS: Record<string, CommandInfo> = {
  // ===== subtitle（subtitle.cpp）=====
  'subtitle/new': {
    label: 'New Subtitles',
    help: 'New subtitles',
    shortcuts: { Default: ['Ctrl-N'] },
  },
  'subtitle/open': {
    label: 'Open Subtitles...',
    help: 'Open a subtitles file',
    shortcuts: { Default: ['Ctrl-O'] },
  },
  'subtitle/open/charset': {
    label: 'Open Subtitles with Charset...',
    help: 'Open a subtitles file with a specific file encoding',
  },
  'subtitle/open/video': {
    label: 'Open Subtitles from Video',
    help: 'Open the subtitles from the current video file',
  },
  'subtitle/open/autosave': {
    label: 'Open Autosaved Subtitles...',
    help: 'Open a previous version of a file which was autosaved by Aegisub',
  },
  'subtitle/save': {
    label: 'Save Subtitles',
    help: 'Save the current subtitles',
    shortcuts: { Default: ['Ctrl-S', 'F2'] },
  },
  'subtitle/save/as': {
    label: 'Save Subtitles as...',
    help: 'Save subtitles with another name',
    shortcuts: { Default: ['Ctrl-Shift-S'] },
  },
  'tool/export': {
    label: 'Export Subtitles...',
    help: 'Save a copy of subtitles in a different format or with processing applied to it',
  },
  'subtitle/properties': { label: 'Properties...', help: 'Open script properties window' },
  'subtitle/attachment': { label: 'Attachments...', help: 'Open the attachment manager dialog' },
  'tool/font_collector': { label: 'Fonts Collector...', help: 'Open fonts collector' },
  'app/exit': { label: 'Exit', help: 'Exit the application', shortcuts: { Default: ['Ctrl-Q'] } },
  'subtitle/close': { label: 'Close', help: 'Close' },

  // ===== edit（edit.cpp）=====
  'edit/undo': { label: 'Undo', help: 'Undo last action', shortcuts: { Default: ['Ctrl-Z'] } },
  'edit/redo': {
    label: 'Redo',
    help: 'Redo last undone action',
    shortcuts: { Default: ['Ctrl-Y'] },
  },
  'edit/line/cut': {
    label: 'Cut Lines',
    help: 'Cut subtitles',
    shortcuts: { Default: ['Ctrl-X'] },
  },
  'edit/line/copy': {
    label: 'Copy Lines',
    help: 'Copy subtitles to the clipboard',
    shortcuts: { Default: ['Ctrl-C'] },
  },
  'edit/line/paste': {
    label: 'Paste Lines',
    help: 'Paste subtitles',
    shortcuts: { Default: ['Ctrl-V'] },
  },
  'edit/line/paste/over': {
    label: 'Paste Lines Over...',
    help: 'Paste subtitles over others',
    shortcuts: { Default: ['Ctrl-Shift-V'] },
  },
  'subtitle/find': {
    label: 'Find...',
    help: 'Search for text in the subtitles',
    shortcuts: { Default: ['Ctrl-F'] },
  },
  'subtitle/find/next': {
    label: 'Find Next',
    help: 'Find next match of last search',
    shortcuts: { Default: ['F3'] },
  },
  'edit/find_replace': {
    label: 'Find and Replace...',
    help: 'Find and replace words in subtitles',
    shortcuts: { Default: ['Ctrl-H'] },
  },

  // ===== tool（tool.cpp）=====
  'tool/style/manager': { label: 'Styles Manager...', help: 'Open the styles manager' },
  'tool/style/assistant': { label: 'Styling Assistant...', help: 'Open styling assistant' },
  'tool/translation_assistant': {
    label: 'Translation Assistant...',
    help: 'Open translation assistant',
  },
  'tool/resampleres': {
    label: 'Resample Resolution...',
    help: 'Resample subtitles to maintain their current appearance at a different script resolution',
  },
  'subtitle/spellcheck': { label: 'Spell Checker...', help: 'Open spell checker' },
  'tool/line/select': { label: 'Select Lines...', help: 'Select lines based on defined criteria' },
  'tool/time/postprocess': {
    label: 'Timing Post-Processor...',
    help: 'Post-process the subtitle timing to add lead-ins and lead-outs, snap timing to scene changes, etc.',
  },
  'tool/time/kanji': { label: 'Kanji Timer...', help: 'Open the Kanji timer copier' },

  // ===== subtitle 行编辑 =====
  'subtitle/insert/before': {
    label: 'Before Current',
    help: 'Insert a new line before the current one',
  },
  'subtitle/insert/after': {
    label: 'After Current',
    help: 'Insert a new line after the current one',
  },
  'subtitle/insert/before/videotime': {
    label: 'Before Current, at Video Time',
    help: 'Insert a new line before the current one, starting at video time',
  },
  'subtitle/insert/after/videotime': {
    label: 'After Current, at Video Time',
    help: 'Insert a new line after the current one, starting at video time',
  },
  'edit/line/duplicate': { label: 'Duplicate Lines', help: 'Duplicate the selected lines' },
  'edit/line/split/before': {
    label: 'Split lines before current frame',
    help: 'Split the current line into a line which ends on the previous frame and a line which starts on the current frame',
    shortcuts: { Default: ['Ctrl-D'] },
  },
  'edit/line/split/after': {
    label: 'Split lines after current frame',
    help: 'Split the current line into a line which ends on the current frame and a line which starts on the next frame',
    shortcuts: { Default: ['Ctrl-Shift-D'] },
  },
  'edit/line/split/by_karaoke': {
    label: 'Split Lines (by karaoke)',
    help: 'Use karaoke timing to split line into multiple smaller lines',
  },
  'edit/line/split/preserve': {
    label: 'Split at cursor (preserve times)',
    help: "Split the current line at the cursor, setting both lines to the original line's times",
  },
  'edit/line/split/estimate': {
    label: 'Split at cursor (estimate times)',
    help: "Split the current line at the cursor, dividing the original line's duration between the new ones",
  },
  'edit/line/split/video': {
    label: 'Split at cursor (at video frame)',
    help: "Split the current line at the cursor, dividing the line's duration at the current video frame",
  },
  'edit/line/delete': {
    label: 'Delete Lines',
    help: 'Delete currently selected lines',
    shortcuts: { Default: ['Ctrl-Delete'] },
  },
  'edit/line/join/concatenate': {
    label: 'Concatenate',
    help: 'Join selected lines in a single one, concatenating text together',
  },
  'edit/line/join/keep_first': {
    label: 'Keep First',
    help: 'Join selected lines in a single one, keeping text of first and discarding remaining',
  },
  'edit/line/join/as_karaoke': {
    label: 'As Karaoke',
    help: 'Join selected lines in a single one, as karaoke',
  },
  'edit/line/recombine': {
    label: 'Recombine Lines',
    help: 'Recombine subtitles which have been split and merged',
  },

  // ===== grid（grid.cpp）=====
  'grid/sort/start': { label: 'Start Time', help: 'Sort all subtitles by their start times' },
  'grid/sort/end': { label: 'End Time', help: 'Sort all subtitles by their end times' },
  'grid/sort/style': { label: 'Style Name', help: 'Sort all subtitles by their style names' },
  'grid/sort/actor': { label: 'Actor Name', help: 'Sort all subtitles by their actor names' },
  'grid/sort/effect': { label: 'Effect', help: 'Sort all subtitles by their effects' },
  'grid/sort/layer': { label: 'Layer', help: 'Sort all subtitles by their layer number' },
  'grid/sort/start/selected': {
    label: 'Start Time',
    help: 'Sort selected subtitles by their start times',
  },
  'grid/sort/end/selected': {
    label: 'End Time',
    help: 'Sort selected subtitles by their end times',
  },
  'grid/sort/style/selected': {
    label: 'Style Name',
    help: 'Sort selected subtitles by their style names',
  },
  'grid/sort/actor/selected': {
    label: 'Actor Name',
    help: 'Sort selected subtitles by their actor names',
  },
  'grid/sort/effect/selected': {
    label: 'Effect',
    help: 'Sort selected subtitles by their effects',
  },
  'grid/sort/layer/selected': {
    label: 'Layer',
    help: 'Sort selected subtitles by their layer number',
  },
  'grid/move/up': {
    label: 'Move line up',
    help: 'Move the selected lines up one row',
    shortcuts: { Default: ['Alt-Up'] },
  },
  'grid/move/down': {
    label: 'Move line down',
    help: 'Move the selected lines down one row',
    shortcuts: { Default: ['Alt-Down'] },
  },
  'subtitle/select/all': {
    label: 'Select All',
    help: 'Select all dialogue lines',
    shortcuts: { 'Subtitle Grid': ['Ctrl-A'] },
  },
  'subtitle/select/visible': {
    label: 'Select Visible',
    help: 'Select all dialogue lines that are visible on the current video frame',
  },
  'grid/swap': { label: 'Swap Lines', help: 'Swap the two selected lines' },
  'grid/line/next': {
    label: 'Next Line',
    help: 'Move to the next subtitle line',
    shortcuts: {
      Default: ['Ctrl-KP_2'],
      'Styling Assistant': ['PageDown'],
      'Translation Assistant': ['PageDown'],
    },
  },
  'grid/line/next/create': {
    label: 'Next Line',
    help: 'Move to the next subtitle line, creating a new one if needed',
    shortcuts: { 'Subtitle Edit Box': ['Enter', 'KP_Enter'] },
  },
  'grid/line/prev': {
    label: 'Previous Line',
    help: 'Move to the previous line',
    shortcuts: {
      Default: ['Ctrl-KP_8'],
      'Styling Assistant': ['PageUp'],
      'Translation Assistant': ['PageUp'],
    },
  },
  'grid/tags/show': { label: 'Show Tags', help: 'Show full override tags in the subtitle grid' },
  'grid/tags/simplify': {
    label: 'Simplify Tags',
    help: 'Replace override tags in the subtitle grid with a simplified placeholder',
  },
  'grid/tags/hide': { label: 'Hide Tags', help: 'Hide override tags in the subtitle grid' },
  'grid/tag/cycle_hiding': {
    label: 'Cycle Tag Hiding Mode',
    help: 'Cycle through tag hiding modes',
  },

  // ===== time（time.cpp）=====
  'time/shift': {
    label: 'Shift Times...',
    help: 'Shift subtitles by time or frames',
    shortcuts: { Default: ['Ctrl-I'] },
  },
  'time/snap/start_video': {
    label: 'Snap Start to Video',
    help: 'Set start of selected subtitles to current video frame',
    shortcuts: { Default: ['Ctrl-3'] },
  },
  'time/snap/end_video': {
    label: 'Snap End to Video',
    help: 'Set end of selected subtitles to current video frame',
    shortcuts: { Default: ['Ctrl-4'] },
  },
  'time/snap/scene': {
    label: 'Snap to Scene',
    help: 'Set start and end of subtitles to the keyframes around current video frame',
    shortcuts: { Default: ['Ctrl-5'] },
  },
  'time/frame/current': {
    label: 'Shift to Current Frame',
    help: 'Shift selection so that the active line starts at current frame',
    shortcuts: { Default: ['Ctrl-6'] },
  },
  'time/continuous/start': {
    label: 'Change Start',
    help: "Change start times of lines to the previous line's end time",
  },
  'time/continuous/end': {
    label: 'Change End',
    help: "Change end times of lines to the next line's start time",
  },
  'time/prev': {
    label: 'Previous Line',
    help: 'Previous line or syllable',
    shortcuts: { Always: ['KP_0'], Audio: ['Left', 'Z'] },
  },
  'time/next': {
    label: 'Next Line',
    help: 'Next line or syllable',
    shortcuts: { Always: ['KP_2'], Audio: ['Right', 'X'] },
  },
  'time/lead/in': {
    label: 'Add lead in',
    help: 'Add the lead in time to the selected lines',
    shortcuts: { Audio: ['C'] },
  },
  'time/lead/out': {
    label: 'Add lead out',
    help: 'Add the lead out time to the selected lines',
    shortcuts: { Audio: ['V'] },
  },
  'time/lead/both': {
    label: 'Add lead in and out',
    help: 'Add both lead in and out to the selected lines',
  },
  'time/start/increase': {
    label: 'Shift start time forward',
    help: 'Shift the start time of the current timing unit forward',
    shortcuts: { Always: ['KP_6'] },
  },
  'time/start/decrease': {
    label: 'Shift start time backward',
    help: 'Shift the start time of the current timing unit backward',
    shortcuts: { Always: ['KP_4'] },
  },
  'time/length/increase': {
    label: 'Increase length',
    help: 'Increase the length of the current timing unit',
    shortcuts: { Always: ['KP_9'], Audio: ['KP_Add'] },
  },
  'time/length/decrease': {
    label: 'Decrease length',
    help: 'Decrease the length of the current timing unit',
    shortcuts: { Always: ['KP_7'], Audio: ['KP_Subtract'] },
  },
  'time/length/increase/shift': {
    label: 'Increase length and shift',
    help: 'Increase the length of the current timing unit and shift the following items',
    shortcuts: { Audio: ['Shift-KP_Add'] },
  },
  'time/length/decrease/shift': {
    label: 'Decrease length and shift',
    help: 'Decrease the length of the current timing unit and shift the following items',
    shortcuts: { Audio: ['Shift-KP_Subtract'] },
  },

  // ===== timecode / keyframe（timecode.cpp / keyframe.cpp）=====
  'timecode/open': { label: 'Open Timecodes File...', help: 'Open a VFR timecodes v1 or v2 file' },
  'timecode/save': { label: 'Save Timecodes File...', help: 'Save a VFR timecodes v2 file' },
  'timecode/close': {
    label: 'Close Timecodes File',
    help: 'Close the currently open timecodes file',
  },
  'keyframe/open': { label: 'Open Keyframes...', help: 'Open a keyframe list file' },
  'keyframe/save': {
    label: 'Save Keyframes...',
    help: 'Save the current list of keyframes to a file',
  },
  'keyframe/close': {
    label: 'Close Keyframes',
    help: 'Discard the currently loaded keyframes and use those from the video, if any',
  },

  // ===== video（video.cpp / vis_tool.cpp）=====
  'video/open': { label: 'Open Video...', help: 'Open a video file' },
  'video/open/dummy': {
    label: 'Use Dummy Video...',
    help: 'Open a placeholder video clip with solid color',
  },
  'video/close': { label: 'Close Video', help: 'Close the currently open video file' },
  'video/details': { label: 'Show Video Details', help: 'Show video details' },
  'video/detach': {
    label: 'Detach Video',
    help: 'Detach the video display from the main window, displaying it in a separate Window',
  },
  'video/copy_coordinates': {
    label: 'Copy coordinates to Clipboard',
    help: 'Copy the current coordinates of the mouse over the video to the clipboard',
  },
  'video/jump': {
    label: 'Jump to...',
    help: 'Jump to frame or time',
    shortcuts: { Default: ['Ctrl-G'] },
  },
  'video/jump/start': {
    label: 'Jump Video to Start',
    help: 'Jump the video to the start frame of current subtitle',
    shortcuts: { Default: ['Ctrl-1'] },
  },
  'video/jump/end': {
    label: 'Jump Video to End',
    help: 'Jump the video to the end frame of current subtitle',
    shortcuts: { Default: ['Ctrl-2'] },
  },
  'video/play': {
    label: 'Play',
    help: 'Play the video starting on this position',
    shortcuts: { Default: ['Ctrl-P'] },
  },
  'video/play/line': { label: 'Play line', help: 'Play the video for the current line' },
  'video/stop': { label: 'Stop video', help: 'Stop video playback' },
  'video/frame/prev': {
    label: 'Previous Frame',
    help: 'Seek to the previous frame',
    shortcuts: { Default: ['Ctrl-KP_4'], Video: ['Left'], 'Subtitle Grid': ['Left'] },
  },
  'video/frame/next': {
    label: 'Next Frame',
    help: 'Seek to the next frame',
    shortcuts: { Default: ['Ctrl-KP_6'], Video: ['Right'], 'Subtitle Grid': ['Right'] },
  },
  'video/frame/prev/keyframe': {
    label: 'Previous Keyframe',
    help: 'Seek to the previous keyframe',
    shortcuts: { Video: ['Shift-Left'], 'Subtitle Grid': ['Shift-Left'] },
  },
  'video/frame/next/keyframe': {
    label: 'Next Keyframe',
    help: 'Seek to the next keyframe',
    shortcuts: { Video: ['Shift-Right'], 'Subtitle Grid': ['Shift-Right'] },
  },
  'video/frame/prev/boundary': {
    label: 'Previous Boundary',
    help: 'Seek to the previous beginning or end of a subtitle',
    shortcuts: { Video: ['Ctrl-Left'], 'Subtitle Grid': ['Ctrl-Left'] },
  },
  'video/frame/next/boundary': {
    label: 'Next Boundary',
    help: 'Seek to the next beginning or end of a subtitle',
    shortcuts: { Video: ['Ctrl-Right'], 'Subtitle Grid': ['Ctrl-Right'] },
  },
  'video/frame/prev/large': {
    label: 'Fast jump backwards',
    help: 'Fast jump backwards',
    shortcuts: { Video: ['Alt-Left'], 'Subtitle Grid': ['Alt-Left'] },
  },
  'video/frame/next/large': {
    label: 'Fast jump forward',
    help: 'Fast jump forward',
    shortcuts: { Video: ['Alt-Right'], 'Subtitle Grid': ['Alt-Right'] },
  },
  'video/frame/save': {
    label: 'Save PNG snapshot',
    help: "Save the currently displayed frame to a PNG file in the video's directory",
  },
  'video/frame/save/raw': {
    label: 'Save PNG snapshot (no subtitles)',
    help: "Save the currently displayed frame without the subtitles to a PNG file in the video's directory",
  },
  'video/frame/save/subs': {
    label: 'Save PNG snapshot (only subtitles)',
    help: "Save the currently displayed subtitles with transparent background to a PNG file in the video's directory",
  },
  'video/frame/copy': {
    label: 'Copy image to Clipboard',
    help: 'Copy the currently displayed frame to the clipboard',
  },
  'video/frame/copy/raw': {
    label: 'Copy image to Clipboard (no subtitles)',
    help: 'Copy the currently displayed frame to the clipboard, without the subtitles',
  },
  'video/frame/copy/subs': {
    label: 'Copy image to Clipboard (only subtitles)',
    help: 'Copy the currently displayed subtitles to the clipboard, with transparent background',
  },
  'video/focus_seek': {
    label: 'Toggle video slider focus',
    help: 'Toggle focus between the video slider and the previous thing to have focus',
    shortcuts: { Default: ['Ctrl-Space'] },
  },
  'video/zoom/in': {
    label: 'Zoom In',
    help: 'Zoom video in',
    shortcuts: { Default: ['Ctrl-KP_Add'] },
  },
  'video/zoom/out': {
    label: 'Zoom Out',
    help: 'Zoom video out',
    shortcuts: { Default: ['Ctrl-KP_Subtract'] },
  },
  'video/zoom/50': { label: '50%', help: 'Set zoom to 50%' },
  'video/zoom/100': { label: '100%', help: 'Set zoom to 100%' },
  'video/zoom/200': { label: '200%', help: 'Set zoom to 200%' },
  'video/aspect/default': { label: 'Default', help: "Use video's original aspect ratio" },
  'video/aspect/full': { label: 'Fullscreen (4:3)', help: 'Force video to 4:3 aspect ratio' },
  'video/aspect/wide': { label: 'Widescreen (16:9)', help: 'Force video to 16:9 aspect ratio' },
  'video/aspect/cinematic': { label: 'Cinematic (2.35)', help: 'Force video to 2.35 aspect ratio' },
  'video/aspect/custom': { label: 'Custom...', help: 'Force video to a custom aspect ratio' },
  'video/opt/autoscroll': {
    label: 'Toggle autoscroll of video',
    help: 'Toggle automatically seeking video to the start time of selected lines',
  },
  'video/show_overscan': {
    label: 'Show Overscan Mask',
    help: 'Show a mask over the video, indicating areas that might get cropped off by overscan on televisions',
  },
  'video/reset_pan': {
    label: 'Reset Video Pan',
    help: "Reset the video's position in the video display",
  },
  'video/tool/cross': {
    label: 'Standard',
    help: 'Standard mode, double click sets position',
    shortcuts: { Video: ['A'] },
  },
  'video/tool/drag': { label: 'Drag', help: 'Drag subtitles', shortcuts: { Video: ['S'] } },
  'video/tool/rotate/z': {
    label: 'Rotate Z',
    help: 'Rotate subtitles on their Z axis',
    shortcuts: { Video: ['D'] },
  },
  'video/tool/rotate/xy': {
    label: 'Rotate XY',
    help: 'Rotate subtitles on their X and Y axes',
    shortcuts: { Video: ['F'] },
  },
  'video/tool/perspective': {
    label: 'Apply 3D Perspective',
    help: "Rotate and shear subtitles to make them fit a given quad's perspective",
    shortcuts: { Video: ['G'] },
  },
  'video/tool/scale': {
    label: 'Scale',
    help: 'Scale subtitles on X and Y axes',
    shortcuts: { Video: ['G'] },
  },
  'video/tool/clip': {
    label: 'Clip',
    help: 'Clip subtitles to a rectangle',
    shortcuts: { Video: ['H'] },
  },
  'video/tool/vector_clip': {
    label: 'Vector Clip',
    help: 'Clip subtitles to a vectorial area',
    shortcuts: { Video: ['J'] },
  },
  // 3D 透视子设置（vis_tool.cpp visual_mode_perspective_*）：仅菜单项，无热键
  'video/tool/perspective/plane': {
    label: 'Show Surrounding Plane',
    help: 'Toggles showing a second quad for the ambient 3D plane.',
  },
  'video/tool/perspective/lock_outer': {
    label: 'Lock Outer Quad',
    help: 'When the surrounding plane is also visible, switches which quad is locked. If inactive, the inner quad can only be resized without changing the perspective plane. If active, this holds for the outer quad instead.',
  },
  'video/tool/perspective/grid': {
    label: 'Show Grid',
    help: 'Toggles showing a 3D grid in the visual perspective tool',
  },
  'video/tool/perspective/orgmode/center': {
    label: '\\org Mode: Center',
    help: 'Puts \\org at the center of the perspective quad',
  },
  'video/tool/perspective/orgmode/nofax': {
    label: '\\org Mode: No \\fax',
    help: 'Finds a value for \\org where \\fax can be zero, if possible. Use this mode if your event contains line breaks.',
  },
  'video/tool/perspective/orgmode/keep': {
    label: '\\org Mode: Keep',
    help: 'Fixes the position of \\org',
  },
  'video/tool/perspective/orgmode/cycle': {
    label: 'Cycle \\org mode',
    help: 'Cycles through the three \\org modes',
  },
  'video/tool/vclip/drag': { label: 'Drag', help: 'Drag control points' },
  'video/tool/vclip/line': { label: 'Line', help: 'Append a line' },
  'video/tool/vclip/bicubic': { label: 'Bicubic', help: 'Append a bezier bicubic curve' },
  'video/tool/vclip/convert': {
    label: 'Convert',
    help: 'Convert a segment between line and bicubic',
  },
  'video/tool/vclip/insert': { label: 'Insert', help: 'Insert a control point' },
  'video/tool/vclip/remove': { label: 'Remove', help: 'Remove a control point' },
  'video/tool/vclip/freehand': { label: 'Freehand', help: 'Draw a freehand shape' },
  'video/tool/vclip/freehand_smooth': {
    label: 'Freehand smooth',
    help: 'Draw a smoothed freehand shape',
  },

  // ===== audio（audio.cpp）=====
  'audio/open': { label: 'Open Audio File...', help: 'Open an audio file' },
  'audio/open/video': {
    label: 'Open Audio from Video',
    help: 'Open the audio from the current video file',
  },
  'audio/close': { label: 'Close Audio', help: 'Close the currently open audio file' },
  'audio/save/clip': {
    label: 'Create audio clip',
    help: 'Save an audio clip of the selected line',
  },
  'audio/view/spectrum': {
    label: 'Spectrum Display',
    help: 'Display audio as a frequency-power spectrograph',
  },
  'audio/view/waveform': {
    label: 'Waveform Display',
    help: 'Display audio as a linear amplitude graph',
  },
  'audio/open/blank': {
    label: 'Open 2h30 Blank Audio',
    help: 'Open a 150 minutes blank audio clip, for debugging',
  },
  'audio/open/noise': {
    label: 'Open 2h30 Noise Audio',
    help: 'Open a 150 minutes noise-filled audio clip, for debugging',
  },
  'audio/commit': {
    label: 'Commit',
    help: 'Commit any pending audio timing changes',
    shortcuts: { Always: ['KP_Enter'], Audio: ['Enter', 'G'] },
  },
  'audio/commit/default': {
    label: 'Commit and use default timing for next line',
    help: "Commit any pending audio timing changes and reset the next line's times to the default",
    shortcuts: { Audio: ['Shift-G'] },
  },
  'audio/commit/stay': {
    label: 'Commit and stay on current line',
    help: 'Commit any pending audio timing changes and stay on the current line',
  },
  'audio/play/selection': {
    label: 'Play audio selection',
    help: 'Play audio until the end of the selection is reached',
    shortcuts: { Always: ['KP_5'], Audio: ['S', 'Space'] },
  },
  'audio/play/line': {
    label: 'Play current line',
    help: 'Play the audio for the current line',
    shortcuts: { Audio: ['R'] },
  },
  'audio/play/selection/before': {
    label: 'Play 500 ms before selection',
    help: 'Play 500 ms before selection',
    shortcuts: { Always: ['KP_1'], Audio: ['Q'] },
  },
  'audio/play/selection/after': {
    label: 'Play 500 ms after selection',
    help: 'Play 500 ms after selection',
    shortcuts: { Always: ['KP_3'], Audio: ['W'] },
  },
  'audio/play/selection/begin': {
    label: 'Play first 500 ms of selection',
    help: 'Play first 500 ms of selection',
    shortcuts: { Audio: ['E'] },
  },
  'audio/play/selection/end': {
    label: 'Play last 500 ms of selection',
    help: 'Play last 500 ms of selection',
    shortcuts: { Audio: ['D'] },
  },
  'audio/play/to_end': {
    label: 'Play from selection start to end of file',
    help: 'Play from selection start to end of file',
    shortcuts: { Audio: ['T'] },
  },
  'audio/play/toggle': {
    label: 'Play audio selection or stop',
    help: "Play selection, or stop playback if it's already playing",
    shortcuts: { Audio: ['B'] },
  },
  'audio/scroll/left': {
    label: 'Scroll left',
    help: 'Scroll the audio display left',
    shortcuts: { Audio: ['A'] },
  },
  'audio/scroll/right': {
    label: 'Scroll right',
    help: 'Scroll the audio display right',
    shortcuts: { Audio: ['F'] },
  },
  'audio/stop': {
    label: 'Stop playing',
    help: 'Stop audio and video playback',
    shortcuts: { Always: ['KP_8'], Audio: ['H'] },
  },
  'audio/go_to': {
    label: 'Go to selection',
    help: 'Scroll the audio display to center on the current audio selection',
  },
  'audio/opt/autocommit': {
    label: 'Automatically commit all changes',
    help: 'Automatically commit all changes',
  },
  'audio/opt/autonext': {
    label: 'Auto go to next line on commit',
    help: 'Automatically go to next line on commit',
  },
  'audio/opt/autoscroll': {
    label: 'Auto scroll audio display to selected line',
    help: 'Auto scroll audio display to selected line',
  },
  'audio/opt/spectrum': { label: 'Spectrum analyzer mode', help: 'Spectrum analyzer mode' },
  'audio/opt/vertical_link': {
    label: 'Link vertical zoom and volume sliders',
    help: 'Link vertical zoom and volume sliders',
  },
  'audio/karaoke': { label: 'Toggle karaoke mode', help: 'Toggle karaoke mode' },
  'app/toggle/global_hotkeys': {
    label: 'Toggle global hotkey overrides',
    help: 'Toggle global hotkey overrides (Medusa Mode)',
    shortcuts: { Audio: ['Ctrl-KP_Multiply'] },
  },

  // ===== edit box 文本工具（edit.cpp）=====
  'edit/style/bold': {
    label: 'Bold',
    help: 'Toggle bold (\\b) for the current selection or at the current cursor position',
  },
  'edit/style/italic': {
    label: 'Italics',
    help: 'Toggle italics (\\i) for the current selection or at the current cursor position',
  },
  'edit/style/underline': {
    label: 'Underline',
    help: 'Toggle underline (\\u) for the current selection or at the current cursor position',
  },
  'edit/style/strikeout': {
    label: 'Strikeout',
    help: 'Toggle strikeout (\\s) for the current selection or at the current cursor position',
  },
  'edit/font': { label: 'Font Face', help: 'Select a font face and size' },
  'edit/color/primary': {
    label: 'Primary Color',
    help: 'Set the primary fill color (\\c) at the cursor position',
    shortcuts: { 'Subtitle Edit Box': ['Alt-1'] },
  },
  'edit/color/secondary': {
    label: 'Secondary Color',
    help: 'Set the secondary (karaoke) fill color (\\2c) at the cursor position',
    shortcuts: { 'Subtitle Edit Box': ['Alt-2'] },
  },
  'edit/color/outline': {
    label: 'Outline Color',
    help: 'Set the outline color (\\3c) at the cursor position',
    shortcuts: { 'Subtitle Edit Box': ['Alt-3'] },
  },
  'edit/color/shadow': {
    label: 'Shadow Color',
    help: 'Set the shadow color (\\4c) at the cursor position',
    shortcuts: { 'Subtitle Edit Box': ['Alt-4'] },
  },
  'edit/revert': {
    label: 'Revert',
    help: 'Revert the active line to its initial state (shown in the upper editor)',
  },
  'edit/clear': { label: 'Clear', help: "Clear the current line's text" },
  'edit/clear/text': {
    label: 'Clear Text',
    help: "Clear the current line's text, leaving override tags",
  },
  'edit/insert_original': {
    label: 'Insert Original',
    help: 'Insert the original line text at the cursor',
  },

  // ===== app / view（app.cpp）=====
  'app/display/subs': { label: 'Subs Only View', help: 'Display the subtitles grid only' },
  'app/display/video_subs': {
    label: 'Video+Subs View',
    help: 'Display video and the subtitles grid only',
  },
  'app/display/audio_subs': {
    label: 'Audio+Subs View',
    help: 'Display audio and the subtitles grid only',
  },
  'app/display/full': { label: 'Full view', help: 'Display audio, video and then subtitles grid' },
  'app/toggle/toolbar': { label: 'Show Toolbar', help: 'Toggle the main toolbar' },
  'app/new_window': { label: 'New Window', help: 'Open a new application window' },
  'app/language': { label: 'Language...', help: 'Select Aegisub interface language' },
  'app/options': {
    label: 'Options...',
    help: 'Configure Aegisub',
    shortcuts: { Default: ['Alt-O'] },
  },
  'app/about': { label: 'About', help: 'About Aegisub' },
  'app/updates': {
    label: 'Check for Updates...',
    help: 'Check to see if there is a new version of Aegisub available',
  },
  'app/log': { label: 'Log window', help: 'View the event log' },

  // ===== help（help.cpp）=====
  'help/contents': { label: 'Contents', help: 'Help topics', shortcuts: { Default: ['F1'] } },
  'help/website': { label: 'Website', help: "Visit Aegisub's official website" },
  'help/bugs': {
    label: 'Bug Tracker...',
    help: "Visit Aegisub's bug tracker to report bugs and request new features",
  },
  'help/irc': { label: 'IRC Channel', help: "Visit Aegisub's official IRC channel" },
  'help/video': {
    label: 'Visual Typesetting',
    help: 'Open the manual page for Visual Typesetting',
  },

  // ===== automation（automation.cpp）=====
  'am/meta': {
    label: 'Automation...',
    help: 'Open automation manager. Ctrl: Rescan autoload folder. Ctrl+Shift: Rescan autoload folder and reload all automation scripts',
  },
}

/**
 * Aegisub GetTooltip：StrHelp + " (" + 该上下文全部热键以 / 连接 + ")"。
 * 用于工具栏按钮与编辑框按钮的 tooltip（toolbar.cpp / tooltip_binding.cpp）。
 * StrHelp 文本经 i18n 翻译（po msgid）。
 */
export function commandTooltip(commandId: string, context: ShortcutContext): string {
  const info = COMMANDS[commandId]
  if (!info) return commandId
  const keys = getActiveHotkeys()[context]?.[commandId] ?? info.shortcuts?.[context] ?? []
  const help = tPlain(info.help ?? info.label)
  return keys.length ? `${help} (${keys.join('/')})` : help
}

export function primaryShortcut(commandId: string): string {
  return aegisubPrimaryShortcut(commandId) || (COMMANDS[commandId]?.shortcuts?.Default?.[0] ?? '')
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
  }
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
  }
  let key = codeMap[event.code] ?? keyMap[event.key] ?? event.key
  if (key.length === 1) key = key.toUpperCase()
  const modifiers: string[] = []
  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return [...modifiers, key].join('-')
}

export function commandForShortcut(shortcut: string, context: ShortcutContext): string | null {
  return aegisubCommandForShortcut(shortcut, context, (fallbackShortcut) => {
    // COMMANDS.shortcuts 注册表与热键表共用同一查找链（源码传播链语义）
    for (const candidateContext of shortcutContextChain(context)) {
      for (const [id, info] of Object.entries(COMMANDS)) {
        if (info.shortcuts?.[candidateContext]?.includes(fallbackShortcut)) return id
      }
    }
    return null
  })
}
