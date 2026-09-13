import type { CoreRequest, CoreResponse, SearchMatch, SearchSettings } from '../workers/protocol'
import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from './types'

type CoreRequestPayload = CoreRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

export class CoreClient {
  private readonly worker = new Worker(new URL('../workers/subtitle.worker.ts', import.meta.url), {
    type: 'module',
  })
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (value: CoreState | Uint8Array | SearchMatch[] | number) => void
      reject: (error: Error) => void
    }
  >()

  constructor() {
    // 相对 base（'./'）在 worker 里会按 worker 脚本 URL 解析，必须先在
    // 主线程对文档 baseURI 绝对化再传入
    this.worker.postMessage({
      method: 'init',
      baseUrl: new URL(import.meta.env.BASE_URL ?? '/', document.baseURI).href,
    } satisfies CoreRequest)
    this.worker.onmessage = ({ data }: MessageEvent<CoreResponse>) => {
      const pending = this.pending.get(data.id)
      if (!pending) return
      this.pending.delete(data.id)
      if (data.error) pending.reject(new Error(data.error))
      else if (data.result !== undefined) pending.resolve(data.result)
    }
  }

  state(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'state' })
  }

  open(bytes: Uint8Array, sourceName: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'open', bytes, sourceName }, [bytes.buffer])
  }

  restore(document: SubtitleDocument): Promise<CoreState> {
    return this.request<CoreState>({ method: 'restore', document })
  }

  apply(commands: CoreCommand[], label: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'apply', commands, label })
  }

  undo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'undo' })
  }
  redo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'redo' })
  }
  export(format?: SubtitleFormat): Promise<Uint8Array> {
    return this.request<Uint8Array>({ method: 'export', format })
  }
  search(settings: SearchSettings): Promise<SearchMatch[]> {
    return this.request<SearchMatch[]>({ method: 'search', settings })
  }
  replaceAll(settings: SearchSettings): Promise<number> {
    return this.request<number>({ method: 'replaceAll', settings })
  }
  /** 运行时配置（Limits/Undo Levels 等）；无响应 */
  configure(config: { undoLevels: number }): void {
    this.worker.postMessage({ method: 'configure', config } satisfies CoreRequest)
  }
  /** 手动保存成功后通知核心：下一次提交不再与保存前合并；无响应 */
  markSaved(): void {
    this.worker.postMessage({ method: 'markSaved' } satisfies CoreRequest)
  }
  close(): void {
    this.worker.terminate()
  }

  private request<T extends CoreState | Uint8Array | SearchMatch[] | number>(
    payload: CoreRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: CoreState | Uint8Array | SearchMatch[] | number) => void,
        reject,
      })
      this.worker.postMessage({ ...payload, id } as CoreRequest, transfer)
    })
  }
}
