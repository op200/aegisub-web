import type { AppFileHandle, FileType, HostAdapter, HostCapabilities, MediaSource } from './types'

interface NativeResponse {
  id: number
  result?: unknown
  error?: string
}

interface NativeBridge {
  postMessage(message: string): void
  platform: 'webview2' | 'android-webview'
}

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage(message: unknown): void
        addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
      }
    }
    AegisubHost?: { postMessage(message: string): void }
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < value.length; offset += chunk)
    binary += String.fromCharCode(...value.subarray(offset, offset + chunk))
  return btoa(binary)
}

function detectBridge(): NativeBridge | null {
  if (window.chrome?.webview) {
    return {
      platform: 'webview2',
      postMessage: (message) => window.chrome!.webview!.postMessage(JSON.parse(message)),
    }
  }
  if (window.AegisubHost)
    return {
      platform: 'android-webview',
      postMessage: (message) => window.AegisubHost!.postMessage(message),
    }
  return null
}

export class NativeHostAdapter implements HostAdapter {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private nextId = 1

  constructor(private readonly bridge: NativeBridge) {
    const receive = (data: unknown) => {
      const response =
        typeof data === 'string' ? (JSON.parse(data) as NativeResponse) : (data as NativeResponse)
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response.result)
    }
    if (bridge.platform === 'webview2')
      window.chrome!.webview!.addEventListener('message', (event) => receive(event.data))
    else
      window.addEventListener('aegisub-host-message', ((event: CustomEvent) =>
        receive(event.detail)) as EventListener)
  }

  async openFile(types: FileType[]): Promise<AppFileHandle | null> {
    return this.request<AppFileHandle | null>('openFile', { types })
  }

  async readFile(file: AppFileHandle): Promise<Uint8Array> {
    if (file.file) return new Uint8Array(await file.file.arrayBuffer())
    const result = await this.request<{ base64: string }>('readFile', { token: file.token })
    return decodeBase64(result.base64)
  }

  async saveFile(name: string, data: Uint8Array, type?: FileType): Promise<void> {
    await this.request('saveFile', { name, base64: encodeBase64(data), type })
  }

  async openMedia(file: AppFileHandle): Promise<MediaSource> {
    const [result, bytes] = await Promise.all([
      this.request<{ url: string }>('openMedia', { token: file.token }),
      this.readFile(file),
    ])
    const analysisBytes = new Uint8Array(bytes.byteLength)
    analysisBytes.set(bytes)
    const analysisFile = new File([analysisBytes.buffer], file.name, {
      type: file.mime ?? 'application/octet-stream',
    })
    return {
      name: file.name,
      url: result.url,
      file: analysisFile,
      kind: file.mime?.startsWith('audio/') ? 'audio' : 'video',
    }
  }

  getCapabilities(): HostCapabilities {
    return {
      platform: this.bridge.platform,
      nativeFileSystem: true,
      nativeMedia: true,
      opfs: 'storage' in navigator && 'getDirectory' in navigator.storage,
      webCodecs: 'VideoDecoder' in window,
    }
  }

  private request<T = void>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.bridge.postMessage(JSON.stringify({ id, method, params }))
    })
  }
}

export function createNativeHostAdapter(): HostAdapter | null {
  const bridge = detectBridge()
  return bridge ? new NativeHostAdapter(bridge) : null
}
