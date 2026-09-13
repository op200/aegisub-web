import type { AppFileHandle, FileType, HostAdapter, HostCapabilities, MediaSource } from './types'

function acceptString(types: FileType[]): string {
  return types.flatMap((type) => Object.values(type.accept).flat()).join(',')
}

async function pickWithInput(types: FileType[]): Promise<AppFileHandle | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptString(types)
    input.onchange = () => {
      const file = input.files?.[0]
      resolve(file ? { name: file.name, file } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export class BrowserHostAdapter implements HostAdapter {
  openFile(types: FileType[]): Promise<AppFileHandle | null> {
    return pickWithInput(types)
  }

  async readFile(handle: AppFileHandle): Promise<Uint8Array> {
    if (!handle.file) throw new Error('The selected file is unavailable')
    return new Uint8Array(await handle.file.arrayBuffer())
  }

  async saveFile(name: string, data: Uint8Array, type?: FileType): Promise<void> {
    const mime = type ? Object.keys(type.accept)[0] : 'application/octet-stream'
    const copy = Uint8Array.from(data)
    const blob = new Blob([copy.buffer], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async openMedia(handle: AppFileHandle): Promise<MediaSource> {
    if (!handle.file) throw new Error('The selected media is unavailable')
    return {
      name: handle.name,
      file: handle.file,
      url: URL.createObjectURL(handle.file),
      kind: handle.file.type.startsWith('audio/') ? 'audio' : 'video',
    }
  }

  getCapabilities(): HostCapabilities {
    return {
      platform: 'browser',
      nativeFileSystem: false,
      nativeMedia: true,
      opfs: 'storage' in navigator && 'getDirectory' in navigator.storage,
      webCodecs: 'VideoDecoder' in window,
    }
  }
}

export const SUBTITLE_FILE_TYPES: FileType[] = [
  {
    description: 'Subtitle files',
    accept: { 'text/plain': ['.ass', '.ssa', '.srt'] },
  },
]

export const MEDIA_FILE_TYPES: FileType[] = [
  {
    description: 'Media files',
    accept: {
      'video/*': ['.mp4', '.mkv', '.webm', '.mov', '.avi'],
      'audio/*': ['.wav', '.mp3', '.flac', '.aac', '.ogg', '.m4a'],
    },
  },
]
