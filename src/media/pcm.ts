/** AudioData → 单声道 Float32（多声道平均）。copyTo 转换失败时回退手动解包。 */
export function audioDataToMono(ad: AudioData): Float32Array {
  const frames = ad.numberOfFrames
  const channels = Math.min(ad.numberOfChannels, 8)
  const mono = new Float32Array(frames)
  if (channels <= 0 || frames <= 0) return mono
  try {
    const plane = new Float32Array(frames)
    for (let channel = 0; channel < channels; channel++) {
      ad.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
      for (let index = 0; index < frames; index++) mono[index] += plane[index]
    }
  } catch {
    const manual = audioDataChannelsManual(ad)
    for (let index = 0; index < frames; index++) {
      let sum = 0
      for (let channel = 0; channel < channels; channel++) sum += manual[channel][index]
      mono[index] = sum / channels
    }
  }
  if (channels > 1) for (let index = 0; index < frames; index++) mono[index] /= channels
  return mono
}

/** AudioData → 每声道 Float32（播放用，不混音）。copyTo 转换失败时回退手动解包。 */
export function audioDataToChannels(ad: AudioData): Float32Array<ArrayBuffer>[] {
  const frames = ad.numberOfFrames
  const channels = Math.min(ad.numberOfChannels, 8)
  if (channels <= 0 || frames <= 0) return [new Float32Array(Math.max(0, frames))]
  try {
    const result: Float32Array<ArrayBuffer>[] = []
    for (let channel = 0; channel < channels; channel++) {
      const plane = new Float32Array(frames)
      ad.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
      result.push(plane)
    }
    return result
  } catch {
    return audioDataChannelsManual(ad)
  }
}

/** AudioData → 每声道 Float32（手动按 ad.format 小端解包） */
function audioDataChannelsManual(ad: AudioData): Float32Array<ArrayBuffer>[] {
  const frames = ad.numberOfFrames
  const channels = ad.numberOfChannels
  if (frames <= 0 || channels <= 0) return [new Float32Array(Math.max(0, frames))]
  // AudioData 的 format 为可空（未指定时按 f32 处理）；data 属于 init 字段，经窄化访问
  const format = ad.format ?? 'f32'
  const host = ad as unknown as { data?: ArrayBuffer | ArrayBufferView }
  if (!host.data) return [new Float32Array(frames)]
  const interleaved = !format.endsWith('-planar')
  const bytes =
    host.data instanceof ArrayBuffer
      ? new Uint8Array(host.data)
      : new Uint8Array(host.data.buffer, host.data.byteOffset, host.data.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const result: Float32Array<ArrayBuffer>[] = []
  for (let channel = 0; channel < channels; channel++) result.push(new Float32Array(frames))
  const readSample = (offset: number): number => {
    switch (format) {
      case 'u8':
      case 'u8-planar':
        return (view.getUint8(offset) - 128) / 128
      case 's16':
      case 's16-planar':
        return view.getInt16(offset * 2, true) / 32768
      case 's32':
      case 's32-planar':
        return view.getInt32(offset * 4, true) / 0x80000000
      default:
        return view.getFloat32(offset * 4, true)
    }
  }
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const offset = interleaved ? frame * channels + channel : channel * frames + frame
      result[channel][frame] = readSample(offset)
    }
  }
  return result
}
