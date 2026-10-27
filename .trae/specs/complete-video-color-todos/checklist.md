# Checklist

- [x] 载入视频后不自动播放，`paused === true` 且 `currentTime === 0`
- [x] fps 由解复用头信息提供（`probeVideoInfo`），`probeVideoFps` 已删除
- [x] `videoColor.ts` 的 `parseContainerColorspace` / `guessColorspace` / `resolveVideoColorTransform` 与 `ycbcr.cpp` 语义一致
- [x] 色彩覆盖层接管画面显示，脚本 `YCbCr Matrix` 改为 `TV.709` 时画面像素发生变化
- [x] `buildFrameCanvas` 保存截图优先使用色彩层像素，截图仍含字幕
- [x] `ScriptPropertiesDialog` 三组框（Script / Resolution / Options）排版与 `dialog_properties.cpp` 一致
- [x] Resolution 三条含 `×` 分隔与 3 个 From video；无视频时 3 个按钮 disabled
- [x] YCbCr 下拉为 9 个 `valid_header_strings`；From video 写入 `to_best_practice_string`
- [x] Wrap Style 4 条文案与源码一致（含 `is wider` / `only \N breaks` / `both \n and \N break`）
- [x] 对话框按钮 OK / Cancel / Help；Help 打开 docs Properties 页
- [x] 视频滑块轨道线、关键帧刻度、游标在任意 DPR 下均为清晰 1 像素，无虚边
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全部通过
- [x] `scripts/tmp-*.mjs` 已删除，后台 dev server 已停止
- [x] `未完成计划.md` 5 项已勾选，并补充浏览器色彩限制备忘
