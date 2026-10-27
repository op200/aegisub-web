# Tasks：视频载入 / 色彩 / 脚本属性 / 滑块虚边

## T1 fps 来源改造（待办 1）
- [x] 1.1 `src/media/demux.ts` 新增 `VideoStreamInfo` 与 `probeVideoInfo(file)`（头信息，`finally destroy()`）
- [x] 1.2 `src/ui/App.tsx`：`openVideoHandle` 并行 `probeVideoInfo`，`scanId` 校验后 `setDetectedFps` + `setVideoColorspace`
- [x] 1.3 `src/ui/components/PreviewPane.tsx`：删除 `probeVideoFps` / `fpsProbedRef` / `onLoadedMetadata` 调用
- [x] 1.4 `pnpm typecheck` 通过

## T2 颜色管线（待办 2 + 3）
- [x] 2.1 `src/core/resample.ts`：`YcbcrMatrix` 增加 `BT2020_NCL`/`BT2020_CL`，补 `MATRIX_COEFFICIENTS`；抽出 `ycbcrAffine`
- [x] 2.2 新增 `src/media/videoColor.ts`：`parseContainerColorspace` / `guessColorspace` / `resolveVideoColorTransform` / `VideoColorStage`
- [x] 2.3 `src/ui/styles.css`：`.video-color-stage`
- [x] 2.4 `PreviewPane.tsx`：接入色彩覆盖层（rVFC/rAF 绘制，脚本头变化立即重绘）
- [x] 2.5 `PreviewPane.tsx`：`buildFrameCanvas` 优先从色彩层取像素
- [x] 2.6 `pnpm typecheck && pnpm lint` 通过

## T3 脚本属性对话框（待办 4）
- [x] 3.1 `dialogs.tsx`：重写 `ScriptPropertiesDialog`（新 `video` prop；三组框、`×`、3 个 From video、9 个 YCbCr 选项、源码 Wrap Style 文案/tooltip、Help 按钮）
- [x] 3.2 `App.tsx`：调用点传入 `video={{ width, height, colorspace }}`（无视频为 `null`）
- [x] 3.3 `pnpm typecheck && pnpm lint` 通过

## T4 滑块 1 像素描边（待办 5）
- [x] 4.1 `PreviewPane.tsx` VideoSlider：1px 描边对齐设备像素栅格（轨道线、关键帧刻度、游标），任意 DPR 无虚边
- [x] 4.2 `pnpm typecheck && pnpm lint` 通过

## T5 验证与收尾
- [x] 5.1 `pnpm test` 通过
- [x] 5.2 Playwright 实测：载入不播放、对话框结构/禁用态/YCbCr 切换画面变化、滑块截图无虚边、截图含字幕
- [x] 5.3 删除 `scripts/tmp-*.mjs`、停止后台 dev server
- [x] 5.4 勾选 `未完成计划.md` 5 项并补充浏览器色彩限制备忘

# Task Dependencies
- T3 / T4 相互独立，可并行；T5 依赖 T1~T4

# 实测记录（Playwright headless chromium，DPR 1.25 + 1）
- 载入 `test_h264.mp4` 后 1.5s：`paused=true`、`currentTime=0.001s`（源码 SEEK_TRUNCATION 1ms 余量），不再播放
- 色彩层 `canvas.video-color-stage` opacity=1、640×360，中心 mean RGB≈(127.4,127.5,127.0)（非黑）
- 脚本头改 `TV.709`：mean → (133.8,103.0,134.6)（G 差 24.6），改回 `None` 恢复基线
- 对话框：3 个 fieldset（Script/Resolution/Options）、3 个 From video、2 个 `×`、Wrap Style 4 条逐字一致、YCbCr 10 项（含空白原值项）、Help 存在
- 滑块 DPR 1.25：轨道线只在 device 行 10 出现且颜色单一（#6d6d6d），相邻行 0 像素；左右竖框同样单列
- 保存截图：PNG 640×360、41103 字节

## T6 回归修复（用户反馈：画面上下颠倒 + 字幕不渲染）
- [x] 6.1 顶点着色器纹理 V 坐标改为 `0.5 + aPosition.y * 0.5`（`UNPACK_FLIP_Y_WEBGL=true` 时不能再翻转一次）
- [x] 6.2 `.jassub-canvas { z-index: 1 }`、`.video-color-stage { z-index: 0 }`：libass 画布由 `appendChild` 追加到 `.video-zoom-stage`，色彩层是 React 最后一个子节点会被后插到它上面
- [x] 6.3 复验：色彩层与 `<video>` 逐行比对 sameMean=0 / flippedMean=37.7（正向）；jassub z=1 > color z=0；隐藏 jassub 前后截图不同（字幕可见）

## T7 用户复查三项残留
- [x] 7.1 `VideoColorStage.setTransform` 上传前把行主序矩阵重排为列主序（WebGL1 不接受 `transpose=true`，此前 shader 实际乘转置矩阵 → 改色但映射错误）
- [x] 7.2 复验：脚本头 `TV.709` 下 200 个采样点，色彩层像素与 `ycbcrAffine(601/MPEG → 709/MPEG)` 手算值 **maxDiff = 0**
- [x] 7.3 VideoSlider 的 `fillRect`（游标白底、底部选区条）对齐设备像素栅格
- [x] 7.4 游标箭头 4 条斜线改 Bresenham 设备像素台阶（Canvas2D 对角抗锯齿会出 1~2px 半透明边）
- [x] 7.5 复验（DPR 1.25）：滑块画布 20358 像素中非调色板颜色仅 7 个孤立点（原为 15+ 且集中在箭头斜边）
- [x] 7.6 记录 Chrome 色差残留成因（色度升采样 + 浏览器色彩管理）到 `未完成计划.md` 备忘

## T8 滑块最后一点虚像素（用户复查：关键帧竖线正上方的虚像素）
- [x] 8.1 定位：隔离画布重绘证明 `stroke()` 长直线在 DPR 1.25 会在画布中点列（设备列 338）留下半覆盖像素（141 而非 109）——Chrome/Skia 长线栅格化接缝；同样几何用 `fillRect` 无任何半覆盖
- [x] 8.2 轨道四条边、关键帧刻度、游标高光/阴影/轮廓竖线全部改用整数设备像素 `fillRect`（`lineX`/`lineY`），删除 `align`/`alignEdge` 半像素方案
- [x] 8.3 焦点点线框改用逐设备像素点（源码 `wxPENSTYLE_DOT` = 1 设备像素亮/灭）：`setLineDash` 以 CSS px 计长，分数 DPR 下每个点都只覆盖半个设备像素
- [x] 8.4 清除/铺底按后备尺寸（`canvas.width/ratio`）：CSS 尺寸取整零头会让最右列只被半覆盖而呈半透明
- [x] 8.5 复验：DPR 1/1.25/1.5/1.75/2 下整张滑块画布非调色板颜色 **0 个**；点中滑块（焦点 + 游标在中间）后同样为 0
- [x] 8.6 `pnpm typecheck` / `pnpm lint` / `pnpm test` 全通过（238 tests）


