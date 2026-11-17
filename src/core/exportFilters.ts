// 内置导出过滤器——Aegisub 桌面版 export_fixstyle.cpp / export_framerate.cpp 的 TS 移植
//
// 对齐源码：
//   - Aegisub/src/export_fixstyle.cpp（AssFixStylesFilter::ProcessSubs）
//   - Aegisub/src/export_framerate.cpp（Truncate/ConvertTime/TransformTimeTags/TransformFrameRate）
//
// 与源码一致的关键语义（勿"顺手优化"）：
//   - 样式名按 ASCII 字节小写比较（boost::to_lower），未匹配的样式引用改为 "Default"
//   - 时间换算先按输出帧率定位帧，再按输入帧率取该帧起止时间做线性插值
//   - 所有结果为 int：C++ 的 double → int 与整除均向零截断（时间可为负，用 Math.trunc）
//   - 仅 OVERRIDE 块内的 INT/FLOAT 时间参数被改写；\t 的 BLOCK 参数递归处理

import { processCueOverrideParameters, type OverrideParam } from './resample'
import type { SubtitleCue, SubtitleDocument } from './types'
import type { Framerate } from './vfr'

// ---------------------------------------------------------------------------
// Fix Styles（export_fixstyle.cpp L50-L58）
// ---------------------------------------------------------------------------

/** boost::to_lower：按字节 ASCII 小写，非 ASCII 字符原样保留 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * AssFixStylesFilter::ProcessSubs：不在文件样式表中的行样式改为 "Default"。
 * 返回新文档（不可变更新），原文档与未改动的行对象保持原样。
 */
export function fixStyles(document: SubtitleDocument): SubtitleDocument {
  // 源码：GetStyles() 全部小写后排序，再用 binary_search 查行样式
  const styleNames = new Set(document.styles.map((style) => asciiLower(style.name)))
  return {
    ...document,
    cues: document.cues.map((cue) =>
      styleNames.has(asciiLower(cue.style)) ? cue : { ...cue, style: 'Default' },
    ),
  }
}

// ---------------------------------------------------------------------------
// Transform Framerate（export_framerate.cpp L151-L224）
// ---------------------------------------------------------------------------

/** Truncate a time to centisecond precision（C++ 整除向零截断） */
function truncCs(time: number): number {
  return Math.trunc(time / 10) * 10
}

/** AssTransformFramerateFilter::ConvertTime：输出帧率定位 → 输入帧率插值 */
function convertTime(time: number, input: Framerate, output: Framerate): number {
  const frame = output.frameAtTime(time)
  const frameStart = output.timeAtFrame(frame)
  const frameEnd = output.timeAtFrame(frame + 1)
  const frameDur = frameEnd - frameStart
  // 源码此处会除零（异常/空 timecodes）；web 侧防御为时间不变
  if (frameDur === 0) return time
  const dist = (time - frameStart) / frameDur
  const newStart = input.timeAtFrame(frame)
  const newEnd = input.timeAtFrame(frame + 1)
  // C++ 返回 int：double → int 向零截断
  return Math.trunc(newStart + (newEnd - newStart) * dist)
}

/**
 * AssTransformFramerateFilter::TransformTimeTags + TransformFrameRate 的单行版本。
 * 返回该行需要更新的字段：startMs / endMs / text。
 */
export function transformFramerateCue(
  cue: SubtitleCue,
  input: Framerate,
  output: Framerate,
): { startMs: number; endMs: number; text: string } {
  const newStart = truncCs(convertTime(cue.startMs, input, output))
  const newEnd = truncCs(convertTime(cue.endMs, input, output) + 9)

  // karaoke 累计量按行重置（源码 TransformFrameRate 每行 newK = oldK = 0）
  let oldK = 0
  let newK = 0
  const text = processCueOverrideParameters(cue.text, (par: OverrideParam) => {
    if (par.type !== 'INT' && par.type !== 'FLOAT') return
    // 源码 Get<int>()：整数参数即 atoi，FLOAT 亦按 int 读取
    const parVal = par.getInt()

    switch (par.cls) {
      case 'RELATIVE_TIME_START': {
        let value = convertTime(truncCs(cue.startMs) + parVal, input, output) - newStart
        // 结束时间为 0 表示行尾：非 0 值换算后不得变成 0（\move 与 \fad 的行首相对时间）
        if (value === 0 && parVal !== 0) value = 1
        par.setInt(value)
        break
      }
      case 'RELATIVE_TIME_END':
        par.setInt(newEnd - convertTime(truncCs(cue.endMs) - parVal, input, output))
        break
      case 'KARAOKE': {
        const start = Math.trunc(cue.startMs / 10) + oldK + parVal
        const value = Math.trunc((convertTime(start * 10, input, output) - newStart) / 10) - newK
        oldK += parVal
        newK += value
        par.setInt(value)
        break
      }
      default:
        break
    }
  })

  return { startMs: newStart, endMs: newEnd, text }
}

/** AssTransformFramerateFilter::TransformFrameRate：整份文档逐行换算（不可变更新） */
export function transformFramerateDocument(
  document: SubtitleDocument,
  input: Framerate,
  output: Framerate,
): SubtitleDocument {
  // 源码：Input/Output 任一未加载则直接返回
  if (!input.isLoaded() || !output.isLoaded()) return document
  return {
    ...document,
    cues: document.cues.map((cue) => {
      const { startMs, endMs, text } = transformFramerateCue(cue, input, output)
      return { ...cue, startMs, endMs, text }
    }),
  }
}
