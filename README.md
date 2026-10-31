# 项目介绍

Aegisub Web 目的在于尽可能在 Web 端实现 Aegisub 功能，同时提供一些额外的功能

本项目基本完全由 AI 主导

# 使用

## 在线使用

<https://op200.github.io/aegisub-web/>

## 额外功能

与 Aegisub 不同的功能

- 拖入字体文件将载入字体至 IndexedDB
- 左下角可切换视频解码: 浏览器原生 / 内置解码
- 首帧偏移将显式提醒
- 字幕编辑器内的 `!...!` 块有代码高亮

# 已知问题

## Aegisub 功能还原

核心功能基本完成

## 浏览器兼容性

### Firefox

v158.0.1

- 不支持 [`window.queryLocalFonts`](https://caniuse.com/wf-local-fonts)，需要手动载入字体文件
- MP4 容器的部分视频（疑似因为 open-gop）随机 seek 有无法从 IDR 帧解码、会从头解码的 bug
>
- Windows 端遵循注册表 `HKEY_CURRENT_USER\Control Panel\Desktop\CaretTimeout`，导致光标会在超时后停止闪烁  
  解决方法: 修改注册表 or `about:config` -> `ui.caretBlinkCount` 设为负值

### Chrome

v156

- 无法关闭自动色彩管理，导致视频颜色与其他播放器不同  
  所以通过取色编辑 ASS 字幕颜色会导致实际播放时颜色不一致
