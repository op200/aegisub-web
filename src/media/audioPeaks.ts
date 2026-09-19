/**
 * 音频峰值/频谱提取 —— 波形图与频谱图的数据源。
 *
 * 参考 Aegisub 渲染端数据需求（src/audio_renderer_waveform.cpp 每像素 peak、
 * src/audio_renderer_spectrum.cpp FFT 功率块），提取层产出固定时间分辨率的
 * 峰值桶（MS_PER_BUCKET）+ 全程频谱 brick（对齐 FillBlock 派生模型）。
 *
 * 对应原版 FFMS2 的后台索引线程（audio_provider_ffmpegsource.cpp）：解复用 +
 * WebCodecs 解码 + 逐样本峰值/FFT 分析全部在 peaks.worker 后台线程执行，
 * 进度以增量切片上报、主线程仅做装配，界面全程可交互。
 *
 * 两条路径（分析均在 worker 内）：
 * 1. 纯音频容器（mp3/wav/...）→ 主线程 decodeAudioData 全量解码（AudioContext
 *    不可入 worker），声道数据交给 worker 混音 + 分析（快路径，无渐进）
 * 2. 视频容器/大文件（mkv 等）→ worker 内 web-demuxer 拆音频包 + AudioDecoder
 *    流式解码，边解码边累积（不需要把整段 PCM 物化到内存），经 onProgress 渐进上报
 *
 * 吞吐参考：965MB 24 分钟 mkv 全量解码约 3 分钟（约 7× 实时），
 * 期间波形/频谱渐进绘制、界面可交互。
 */
import type { AudioPeaks } from './peakAnalyzer'
import { MS_PER_BUCKET } from './peakAnalyzer'
import type { PeaksWorkerResponse } from './peaks.worker'

export type { AudioPeaks, SpectrumData } from './peakAnalyzer'
export { MS_PER_BUCKET }

const NATIVE_DECODE_LIMIT = 300 * 1024 * 1024
/** decodeAudioData 可靠覆盖的纯音频扩展名（mkv/avi 等直接走解复用路径） */
const NATIVE_AUDIO_EXT = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'm4a',
  'aac',
  'mp4',
  'webm',
])

const fileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/**
 * 提取峰值。onProgress 仅在流式路径触发（渐进渲染波形）；
 * 抛错表示无音频轨或编解码不受支持。
 */
export async function extractAudioPeaks(
  file: File,
  onProgress?: (peaks: AudioPeaks) => void,
): Promise<AudioPeaks> {
  const ext = fileExt(file.name)
  const preferNative = NATIVE_AUDIO_EXT.has(ext) && file.size <= NATIVE_DECODE_LIMIT
  if (preferNative) {
    try {
      return await extractWithDecodeAudioData(file)
    } catch {
      return await extractWithDemuxer(file, onProgress)
    }
  }
  try {
    return await extractWithDemuxer(file, onProgress)
  } catch (error) {
    if (ext !== 'mkv' && file.size <= NATIVE_DECODE_LIMIT) {
      try {
        return await extractWithDecodeAudioData(file)
      } catch {
        // 两者都失败，抛原始错误
      }
    }
    throw error
  }
}

function spawnPeaksWorker(): Worker {
  return new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' })
}

// ---------------------------------------------------------------------------
// 快路径：decodeAudioData 全量解码（解码留在主线程——AudioContext 不可入 worker），
// 声道交给 worker 混音 + 分析
// ---------------------------------------------------------------------------
async function extractWithDecodeAudioData(file: File): Promise<AudioPeaks> {
  const bytes = await file.arrayBuffer()
  if (bytes.byteLength > NATIVE_DECODE_LIMIT)
    throw new Error('Media is too large for browser audio decoding')
  const audioContext = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await audioContext.decodeAudioData(bytes)
  } finally {
    void audioContext.close()
  }
  const durationMs = decoded.duration * 1000
  const channels: Float32Array[] = []
  for (let channel = 0; channel < decoded.numberOfChannels; channel++)
    channels.push(decoded.getChannelData(channel))
  const worker = spawnPeaksWorker()
  return new Promise<AudioPeaks>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      fn()
    }
    worker.onmessage = ({ data }: MessageEvent<PeaksWorkerResponse>) => {
      if (data.type === 'done') {
        settle(() => resolve({ ...data, msPerBucket: MS_PER_BUCKET, progress: 1 }))
      } else if (data.type === 'error') {
        settle(() => reject(new Error(data.message)))
      }
    }
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'Peaks worker failed to load')))
    }
    // AudioBuffer 声道无法转移（decodeAudioData 内部缓冲），structured clone 拷贝
    worker.postMessage({ kind: 'audio-pcm', channels, sampleRate: decoded.sampleRate, durationMs })
  })
}

// ---------------------------------------------------------------------------
// 解复用路径：worker 内 web-demuxer + AudioDecoder 流式解码 + 分析
// ---------------------------------------------------------------------------
async function extractWithDemuxer(
  file: File,
  onProgress?: (peaks: AudioPeaks) => void,
): Promise<AudioPeaks> {
  const worker = spawnPeaksWorker()
  return new Promise<AudioPeaks>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      fn()
    }
    // meta 到达时按最终布局一次性分配 live buffer，后续 progress 仅做增量切片写入
    let meta: Extract<PeaksWorkerResponse, { type: 'meta' }> | null = null
    let peakMin = new Float32Array(0)
    let peakMax = new Float32Array(0)
    let peakAvg = new Float32Array(0)
    let spectrumData: Uint8Array | null = null
    worker.onmessage = ({ data }: MessageEvent<PeaksWorkerResponse>) => {
      if (data.type === 'meta') {
        meta = data
        peakMin = new Float32Array(data.buckets)
        peakMax = new Float32Array(data.buckets)
        peakAvg = new Float32Array(data.buckets)
        spectrumData = data.columns > 0 ? new Uint8Array(data.columns * data.nbrBins) : null
      } else if (data.type === 'progress') {
        if (!meta) return
        peakMin.set(data.min, data.bFrom)
        peakMax.set(data.max, data.bFrom)
        peakAvg.set(data.avg, data.bFrom)
        if (spectrumData && data.kData) spectrumData.set(data.kData, data.kFrom * meta.nbrBins)
        const size = data.bFrom + data.min.length
        onProgress?.({
          durationMs: meta.durationMs,
          msPerBucket: MS_PER_BUCKET,
          peakMin: peakMin.subarray(0, size),
          peakMax: peakMax.subarray(0, size),
          peakAvg: peakAvg.subarray(0, size),
          // 频谱共享同一 buffer（未提交 brick 保持 0 = 调色板 0 级静音背景），
          // 提交后自然显现；消费方在下一次 onProgress 前同步消费，安全
          spectrum:
            spectrumData && meta.columns > 0
              ? {
                  width: meta.columns,
                  height: meta.nbrBins,
                  data: spectrumData,
                  msPerColumn: meta.msPerColumn,
                  sampleRate: meta.sampleRate,
                }
              : null,
          progress: data.progress,
        })
      } else if (data.type === 'done') {
        settle(() => resolve({ ...data, msPerBucket: MS_PER_BUCKET, progress: 1 }))
      } else if (data.type === 'error') {
        settle(() => reject(new Error(data.message)))
      }
    }
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'Peaks worker failed to load')))
    }
    worker.postMessage({ kind: 'audio-demux', file })
  })
}
