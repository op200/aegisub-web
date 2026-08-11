/**
 * Aegisub 命令 → 图标文件映射。
 *
 * 图标源文件来自 Aegisub 源码 `Aegisub/src/bitmaps/button/*.png`（16/24/32/48/64px），
 * 已按 16px + 24px 复制到 `public/icons/aegisub/`。
 * 文件名规则：`{basename}_{size}.png`。
 */

export const COMMAND_ICONS: Record<string, string> = {
  // 文件
  'subtitle/new': 'new_toolbutton',
  'subtitle/open': 'open_toolbutton',
  'subtitle/save': 'save_toolbutton',
  'subtitle/save/as': 'save_as_toolbutton',
  'subtitle/open/video': 'open_video_menu',
  'subtitle/attachment': 'attach_button',
  'subtitle/properties': 'properties_toolbutton',
  'tool/export': 'export_menu',
  'tool/font_collector': 'font_collector_button',
  'app/new_window': 'new_window_menu',
  'subtitle/open/charset': 'open_with_toolbutton',
  'subtitle/open/autosave': 'open_toolbutton',
  // 编辑
  'edit/undo': 'undo_button',
  'edit/redo': 'redo_button',
  'edit/line/cut': 'cut_button',
  'edit/line/copy': 'copy_button',
  'edit/line/paste': 'paste_button',
  'edit/line/delete': 'delete_button',
  'subtitle/find': 'find_button',
  'subtitle/find/next': 'find_next_menu',
  'edit/find_replace': 'find_replace_menu',
  'tool/line/select': 'select_lines_button',
  'subtitle/select/all': 'select_lines_button',
  'subtitle/select/visible': 'select_visible_button',
  'grid/sort/start': 'arrow_sort',
  'grid/sort/end': 'arrow_sort',
  'grid/sort/style': 'arrow_sort',
  'grid/sort/actor': 'arrow_sort',
  'grid/sort/effect': 'arrow_sort',
  'grid/sort/layer': 'arrow_sort',
  'grid/move/up': 'arrow_up',
  'grid/move/down': 'arrow_down',
  'grid/move/up/end': 'arrow_up_stop',
  'grid/move/down/end': 'arrow_down_stop',
  // 字幕/样式
  'tool/style/manager': 'style_toolbutton',
  'tool/style/assistant': 'styling_toolbutton',
  'tool/translation_assistant': 'translation_toolbutton',
  'tool/resampleres': 'resample_toolbutton',
  'subtitle/spellcheck': 'spellcheck_toolbutton',
  'tool/time/postprocess': 'timing_processor_toolbutton',
  'grid/tag/cycle_hiding': 'toggle_tag_hiding',
  // 时间
  'time/shift': 'shift_times_toolbutton',
  'time/snap/start_video': 'substart_to_video',
  'time/snap/end_video': 'subend_to_video',
  'time/snap/scene': 'snap_subs_to_scene',
  'time/frame/current': 'shift_to_frame',
  'time/prev': 'button_prev',
  'time/next': 'button_next',
  'time/lead/in': 'button_leadin',
  'time/lead/out': 'button_leadout',
  // 视频
  'video/open': 'open_video_menu',
  'video/close': 'close_video_menu',
  'video/open/dummy': 'use_dummy_video_menu',
  'video/details': 'show_video_details_menu',
  'video/detach': 'detach_video_menu',
  'video/jump': 'jumpto_button',
  'video/jump/start': 'video_to_substart',
  'video/jump/end': 'video_to_subend',
  'video/play': 'button_play',
  'video/play/line': 'button_playline',
  'video/stop': 'button_stop',
  'video/zoom/in': 'zoom_in_button',
  'video/zoom/out': 'zoom_out_button',
  'video/opt/autoscroll': 'toggle_video_autoscroll',
  'video/tool/cross': 'visual_standard',
  'video/tool/drag': 'visual_move',
  'video/tool/rotate/z': 'visual_rotatez',
  'video/tool/rotate/xy': 'visual_rotatexy',
  'video/tool/scale': 'visual_scale',
  'video/tool/clip': 'visual_clip',
  'video/tool/vector_clip': 'visual_vector_clip',
  'help/video': 'visual_help',
  // 音频
  'audio/open': 'open_audio_menu',
  'audio/open/video': 'open_audio_from_video_menu',
  'audio/close': 'close_audio_menu',
  'audio/view/spectrum': 'toggle_audio_spectrum',
  'audio/play/selection': 'button_playsel',
  'audio/play/line': 'button_playline',
  'audio/play/selection/before': 'button_playfivehbefore',
  'audio/play/selection/after': 'button_playfivehafter',
  'audio/play/selection/begin': 'button_playfirstfiveh',
  'audio/play/selection/end': 'button_playlastfiveh',
  'audio/play/to_end': 'button_playtoend',
  'audio/commit': 'button_audio_commit',
  'audio/stop': 'button_stop',
  'audio/go_to': 'button_audio_goto',
  'audio/opt/autocommit': 'toggle_audio_autocommit',
  'audio/opt/autonext': 'toggle_audio_nextcommit',
  'audio/opt/autoscroll': 'toggle_audio_autoscroll',
  'audio/opt/spectrum': 'toggle_audio_spectrum',
  'audio/opt/vertical_link': 'toggle_audio_link',
  'app/toggle/global_hotkeys': 'toggle_audio_medusa',
  'audio/karaoke': 'kara_mode',
  // 时间码 / 关键帧
  'timecode/open': 'open_timecodes_menu',
  'timecode/save': 'save_timecodes_menu',
  'timecode/close': 'close_timecodes_menu',
  'keyframe/open': 'open_keyframes_menu',
  'keyframe/save': 'save_keyframes_menu',
  'keyframe/close': 'close_keyframes_menu',
  // 自动化
  'am/meta': 'automation_toolbutton',
  'tool/kara_timing_copy': 'kara_timing_copier',
  'automation/again': 'automation_toolbutton',
  // 视图/帮助
  'app/options': 'options_button',
  'app/language': 'languages_menu',
  'app/about': 'about_menu',
  'help/contents': 'contents_button',
  'help/website': 'website_button',
  'help/bugs': 'bugtracker_button',
  'help/irc': 'irc_button',
};

/**
 * 按 Vite base（兼容 GitHub Pages 子路径部署）拼出图标 URL。
 * size 省略时返回不带尺寸后缀的文件（如 app_icon.png）。
 */
export function aegisubIconUrl(basename: string, size?: 16 | 24): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return size ? `${base}icons/aegisub/${basename}_${size}.png` : `${base}icons/aegisub/${basename}.png`;
}

/** 返回指定命令在给定尺寸下的图标 URL（无图标时返回 undefined） */
export function commandIcon(command: string, size: 16 | 24 = 16): string | undefined {
  const basename = COMMAND_ICONS[command];
  return basename ? aegisubIconUrl(basename, size) : undefined;
}
