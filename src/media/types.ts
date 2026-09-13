import type { MediaSource } from '../platform/types'

export interface MediaInfo {
  name: string
  durationMs: number
  width: number
  height: number
  backend: 'native' | 'webcodecs' | 'ffmpeg-wasm' | 'native-bridge'
}

export interface DecodedFrame {
  timeMs: number
  frame?: VideoFrame | ImageBitmap
}

export interface WaveformLevels {
  durationMs: number
  peaks: Float32Array
}

export interface MediaBackend {
  open(source: MediaSource): Promise<MediaInfo>
  seek(timeMs: number): Promise<DecodedFrame>
  play(): void
  pause(): void
  getTimecodes(): Promise<number[]>
  getKeyframes(): Promise<number[]>
  getWaveformPeaks(): Promise<WaveformLevels>
  close(): void
}
