/// <reference lib="webworker" />
// WASM ABI 函数名（_aegisub_*、_malloc 等）必须以下划线开头
/* eslint-disable no-underscore-dangle */
import { createDocument } from '../core/defaults';
import { exportSubtitle } from '../core/format';
import { TypeScriptCoreRuntime } from '../core/runtime';
import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from '../core/types';
import type { CoreRequest, CoreResponse, SearchMatch, SearchSettings } from './protocol';

/**
 * WASM 核心模块接口（Emscripten 导出，见 wasm/aegisub_core_api.h）。
 * 模块文件 build/aegisub_core.js 编译后放入 public/wasm/。
 */
interface AegisubCoreModule {
  _aegisub_core_abi_version(): number;
  _aegisub_document_create(): number;
  _aegisub_document_destroy(document: number): void;
  _aegisub_document_open(document: number, data: number, size: number, sourceName: number): number;
  _aegisub_document_state_json(document: number): number;
  _aegisub_document_apply_json(document: number, commandsJson: number, label: number): number;
  _aegisub_document_undo(document: number): number;
  _aegisub_document_redo(document: number): number;
  _aegisub_document_export(document: number, format: number, sizePtr: number): number;
  _aegisub_document_search(document: number, settings: number): number;
  _aegisub_document_replace_all(document: number, settings: number): number;
  _aegisub_core_free(memory: number): void;
  _aegisub_core_last_error(): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  allocateUTF8(text: string): number;
  UTF8ToString(ptr: number): string;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

interface CoreRuntime {
  open(bytes: Uint8Array, sourceName: string): CoreState;
  restore(document: SubtitleDocument): CoreState;
  apply(commands: CoreCommand[], label: string): CoreState;
  undo(): CoreState;
  redo(): CoreState;
  export(format?: SubtitleFormat): Uint8Array;
  search(settings: SearchSettings): SearchMatch[];
  replaceAll(settings: SearchSettings): number;
  getState(): CoreState;
}

/** 通过 C ABI 调用 WASM 里的 Aegisub 文档核心 */
class WasmCoreRuntime implements CoreRuntime {
  private readonly module: AegisubCoreModule;
  private document: number;

  constructor(module: AegisubCoreModule) {
    this.module = module;
    this.document = module._aegisub_document_create();
  }

  private get error(): string {
    return this.module.UTF8ToString(this.module._aegisub_core_last_error());
  }

  private state(): CoreState {
    const ptr = this.module._aegisub_document_state_json(this.document);
    if (!ptr) throw new Error(this.error);
    const json = this.module.UTF8ToString(ptr);
    this.module._aegisub_core_free(ptr);
    return JSON.parse(json) as CoreState;
  }

  open(bytes: Uint8Array, sourceName: string): CoreState {
    const m = this.module;
    const data = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, data);
    const name = m.allocateUTF8(sourceName);
    const result = m._aegisub_document_open(this.document, data, bytes.length, name);
    m._free(data);
    m._free(name);
    if (result !== 0) throw new Error(this.error);
    return this.state();
  }

  restore(document: SubtitleDocument): CoreState {
    // 把 TS 文档模型序列化回 ASS 文本再载入 WASM（保证 autosave 恢复一致）
    const text = new TextEncoder().encode(exportSubtitle(document, document.format ?? 'ass'));
    return this.open(text, document.sourceName || 'untitled.ass');
  }

  apply(commands: CoreCommand[], label: string): CoreState {
    if (!commands.length) return this.state();
    const m = this.module;
    const cmds = m.allocateUTF8(JSON.stringify(commands));
    const labelPtr = m.allocateUTF8(label);
    const result = m._aegisub_document_apply_json(this.document, cmds, labelPtr);
    m._free(cmds);
    m._free(labelPtr);
    if (result !== 0) throw new Error(this.error);
    return this.state();
  }

  undo(): CoreState {
    this.module._aegisub_document_undo(this.document);
    return this.state();
  }

  redo(): CoreState {
    this.module._aegisub_document_redo(this.document);
    return this.state();
  }

  export(format?: SubtitleFormat): Uint8Array {
    const m = this.module;
    const sizePtr = m._malloc(4);
    const fmt = m.allocateUTF8(format ?? 'ass');
    const dataPtr = m._aegisub_document_export(this.document, fmt, sizePtr);
    m._free(fmt);
    if (!dataPtr) {
      m._free(sizePtr);
      throw new Error(this.error);
    }
    const size = m.HEAP32[sizePtr >> 2];
    const bytes = new Uint8Array(m.HEAPU8.slice(dataPtr, dataPtr + size));
    m._aegisub_core_free(dataPtr);
    m._free(sizePtr);
    return bytes;
  }

  search(settings: SearchSettings): SearchMatch[] {
    const m = this.module;
    const settingsPtr = m.allocateUTF8(JSON.stringify(settings));
    const resultPtr = m._aegisub_document_search(this.document, settingsPtr);
    m._free(settingsPtr);
    if (!resultPtr) throw new Error(this.error);
    const json = m.UTF8ToString(resultPtr);
    m._aegisub_core_free(resultPtr);
    return JSON.parse(json) as SearchMatch[];
  }

  replaceAll(settings: SearchSettings): number {
    const m = this.module;
    const settingsPtr = m.allocateUTF8(JSON.stringify(settings));
    const count = m._aegisub_document_replace_all(this.document, settingsPtr);
    m._free(settingsPtr);
    if (count < 0) throw new Error(this.error);
    return count;
  }

  getState(): CoreState {
    return this.state();
  }

  close(): void {
    this.module._aegisub_document_destroy(this.document);
  }
}

async function loadWasmRuntime(): Promise<CoreRuntime | null> {
  try {
    // 模块文件由 native/ 构建产出后放到 public/wasm/aegisub_core.js
    // 用 fetch + Blob URL 加载，绕过 Vite 对 public 资源的 import 转换；
    // BASE_URL 由 Vite 注入，兼容 GitHub Pages 子路径部署
    const baseUrl = import.meta.env.BASE_URL ?? '/';
    const wasmUrl = `${baseUrl}wasm/aegisub_core.js`;
    const source = await (await fetch(wasmUrl)).text();
    const blob = new Blob([source], { type: 'text/javascript' });
    const objectUrl = URL.createObjectURL(blob);
    const mod = (await import(/* @vite-ignore */ objectUrl)) as {
      default?: (options?: object) => Promise<AegisubCoreModule>;
      createAegisubCore?: (options?: object) => Promise<AegisubCoreModule>;
    };
    const createCore = mod.default ?? mod.createAegisubCore;
    if (!createCore) return null;
    const module = await createCore({ locateFile: (path: string) => `/wasm/${path}` });
    if (module._aegisub_core_abi_version() < 1) return null;
    return new WasmCoreRuntime(module);
  } catch (error) {
    console.error('[aegisub-core] WASM load failed, falling back to TS runtime:', error);
    return null; // WASM 不可用，回退 TS 运行时
  }
}

let runtime: CoreRuntime | null = null;
let tsFallback = new TypeScriptCoreRuntime(createDocument());

const wasmReady: Promise<CoreRuntime | null> = loadWasmRuntime();
void wasmReady.then((wasm) => {
  if (wasm) runtime = wasm;
});

/** 返回当前运行时；首次调用会等待 WASM 就绪（最多 3 秒），超时回退 TS */
async function getActiveRuntime(): Promise<CoreRuntime> {
  if (runtime) return runtime;
  await Promise.race([wasmReady, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  return runtime ?? tsFallback;
}

self.onmessage = (event: MessageEvent<CoreRequest>) => {
  const request = event.data;
  const response: CoreResponse = { id: request.id };
  void (async () => {
    try {
      const active: CoreRuntime = await getActiveRuntime();
      switch (request.method) {
        case 'state':
          response.result = active.getState();
          break;
        case 'open':
          response.result = active.open(request.bytes, request.sourceName);
          break;
        case 'restore':
          response.result = active.restore(request.document);
          break;
        case 'apply':
          response.result = active.apply(request.commands, request.label);
          break;
        case 'undo':
          response.result = active.undo();
          break;
        case 'redo':
          response.result = active.redo();
          break;
        case 'export':
          response.result = active.export(request.format);
          break;
        case 'search':
          response.result = active.search(request.settings);
          break;
        case 'replaceAll':
          response.result = active.replaceAll(request.settings);
          break;
      }
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    self.postMessage(response, response.result instanceof Uint8Array ? [response.result.buffer] : []);
  })();
};
