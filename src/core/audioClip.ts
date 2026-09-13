/**
 * 音频片段导出（对应 Aegisub audio/save/clip：把选中行的时间段导出为 wav）。
 * 用 WebAudio 解码音频文件后切出区间，编码为 16-bit PCM WAV。
 */

function encodeWav(samples: Float32Array, sampleRate: number, channels: number): Uint8Array {
  const frames = samples.length / channels
  const dataSize = frames * channels * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, samples[frame * channels + channel]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

export async function exportAudioClip(
  file: File | undefined,
  startMs: number,
  endMs: number,
): Promise<Uint8Array | null> {
  if (!file) return null
  const context = new OfflineAudioContext(1, 1, 44100)
  const decoded = await context.decodeAudioData(await file.arrayBuffer())
  const sampleRate = decoded.sampleRate
  const start = Math.max(0, Math.floor((startMs / 1000) * sampleRate))
  const end = Math.min(decoded.length, Math.ceil((endMs / 1000) * sampleRate))
  if (end <= start) return null

  const channels = decoded.numberOfChannels
  const frames = end - start
  // 多声道混为单声道，与 Aegisub 单声道 wav 导出一致
  const mono = new Float32Array(frames)
  for (let channel = 0; channel < channels; channel++) {
    const data = decoded.getChannelData(channel)
    for (let i = 0; i < frames; i++) mono[i] += data[start + i] / channels
  }
  return encodeWav(mono, sampleRate, 1)
}
