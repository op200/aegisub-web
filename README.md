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

# 已知问题

## Aegisub 功能还原

部分功能尚未实现

## 浏览器兼容性

### Firefox

v155.0.1

- 不支持 [`window.queryLocalFonts`](https://caniuse.com/wf-local-fonts)，需要手动载入字体文件
- 对 MKV 兼容性不如 Chrome
- 对 HEVC 等格式的部分视频（疑似因为 open-gop）随机 seek 有无法从 IDR 帧解码、会从头解码的 bug
