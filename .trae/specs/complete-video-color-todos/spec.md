# 视频载入 / 色彩 / 脚本属性 / 滑块虚边 Spec

## Why

`未完成计划.md` 中 5 项新增待办尚未解决：载入视频会自动播放并回跳首帧、Chrome 与 Firefox/本地播放器色彩不一致、
脚本头的 `YCbCr Matrix` 不生效、脚本属性对话框排版与源码不符且缺 3 个「从视频获取」按钮、
视频滑块（时间横线 / 关键帧竖线）不是标准 1 像素而是带虚边。

## What Changes

- `PreviewPane` 不再用静音播放采样 fps；fps 改由解复用头信息（`avg_frame_rate`）提供，载入后保持暂停状态。
- 新增 WebGL 色彩层：`<video>` 只负责播放/音频/寻址，画面经 `texImage2D` + RGB 域 3×3 仿射校正后输出，
  绕过 Chrome 对 `<video>` 的直通色彩管理；脚本 `YCbCr Matrix` 变化立即重映射（对齐 `video_controller.cpp` 的 `COMMIT_SCRIPTINFO`）。
- 重写 `ScriptPropertiesDialog` 严格对齐 `Aegisub/src/dialog_properties.cpp`：Script / Resolution / Options 三组框、
  `×` 分隔、9 个 `valid_header_strings` 选项、3 个 From video、源码 Wrap Style 文案、Help 按钮。
- 视频滑块画布所有 1px 描边对齐到设备像素栅格，消掉 DPR 缩放导致的 1~2 像素虚边。
- **BREAKING**（内部 API）：`ScriptPropertiesDialog` 新增必填 `video` prop；`YcbcrMatrix` 增加 `BT2020_NCL`/`BT2020_CL`。

## Impact

- Affected specs: 视频预览、色彩处理、脚本属性对话框、视频滑块绘制
- Affected code: `src/media/demux.ts`、`src/media/videoColor.ts`（新增）、`src/core/resample.ts`、
  `src/ui/App.tsx`、`src/ui/components/PreviewPane.tsx`、`src/ui/components/dialogs.tsx`、`src/ui/styles.css`

## 源码依据

| 语义 | 源码位置 |
| --- | --- |
| header 解析 / effective / guess / best-practice | `Aegisub/libaegisub/common/ycbcr.cpp`、`include/libaegisub/ycbcr.h` |
| 脚本头变化 → 重新设定解码矩阵 | `Aegisub/src/video_controller.cpp`（`COMMIT_SCRIPTINFO` → `SetColorSpace`） |
| 对话框布局、3 个 From video、OK 语义 | `Aegisub/src/dialog_properties.cpp` |
| 滑块绘制（1px pen、关键帧刻度、游标） | `Aegisub/src/video_slider.cpp` `OnPaint` |

## ADDED Requirements

### Requirement: 载入视频不自动播放

- **WHEN** 用户打开视频文件
- **THEN** `<video>` 保持 `paused === true`、`currentTime === 0`，界面不进入播放态；
  fps 由容器头（`avg_frame_rate` → `r_frame_rate`）给出，并在 5..240 范围内才采信。

### Requirement: 脚本 YCbCr Matrix 控制画面

- **THEN** `YCbCr Matrix` 为 `TV.709` / `PC.601` 等有效值时，画面按
  `source(容器标记 + guess_colorspace) → target(to_effective)` 的 3×3 仿射重映射；
  `None` 时不做校正；缺省/非法值按 `to_effective` 强制 `SMPTE170M + MPEG`（与源码一致）。

### Requirement: 脚本属性对话框对齐源码

- **THEN** 三个分组框（Script / Resolution / Options）双列 / 5 列 / 3×2 栅格；
  Resolution 三条：`Script:` `[X]` `×` `[Y]` `[From &video]`、`Layout:` 同构、`YCbCr Matrix:` 下拉跨 3 列 + `[From video]`；
  无视频时 3 个按钮 disabled；按钮 OK / Cancel / Help（Help 打开 docs 的 Properties 页）。

### Requirement: 滑块描边为标准 1 设备像素

- **THEN** 轨道线、关键帧刻度、游标 1px 描边在任意 DPR 下都不出现半透明虚边。

## 限制（写入 `未完成计划.md` 备忘）

浏览器自身的 YUV→RGB 矩阵猜测不可读取；未标记视频只能按 `guess_colorspace` 近似。
彻底掌控需 captureStream/WebCodecs 原始平面（Chrome 有、Firefox 无 `MediaStreamTrackProcessor`）。
