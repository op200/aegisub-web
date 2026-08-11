import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from './types';
import type { CoreRequest, CoreResponse, SearchMatch, SearchSettings } from '../workers/protocol';

type CoreRequestPayload = CoreRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export class CoreClient {
  private readonly worker = new Worker(new URL('../workers/subtitle.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: CoreState | Uint8Array | SearchMatch[] | number) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<CoreResponse>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else if (data.result !== undefined) pending.resolve(data.result);
    };
  }

  state(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'state' });
  }

  open(bytes: Uint8Array, sourceName: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'open', bytes, sourceName }, [bytes.buffer]);
  }

  restore(document: SubtitleDocument): Promise<CoreState> {
    return this.request<CoreState>({ method: 'restore', document });
  }

  apply(commands: CoreCommand[], label: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'apply', commands, label });
  }

  undo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'undo' });
  }
  redo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'redo' });
  }
  export(format?: SubtitleFormat): Promise<Uint8Array> {
    return this.request<Uint8Array>({ method: 'export', format });
  }
  search(settings: SearchSettings): Promise<SearchMatch[]> {
    return this.request<SearchMatch[]>({ method: 'search', settings });
  }
  replaceAll(settings: SearchSettings): Promise<number> {
    return this.request<number>({ method: 'replaceAll', settings });
  }
  close(): void {
    this.worker.terminate();
  }

  private request<T extends CoreState | Uint8Array | SearchMatch[] | number>(
    payload: CoreRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: CoreState | Uint8Array | SearchMatch[] | number) => void,
        reject,
      });
      this.worker.postMessage({ ...payload, id } as CoreRequest, transfer);
    });
  }
}
