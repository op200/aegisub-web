export interface FileType {
  description: string;
  accept: Record<string, string[]>;
}

export interface AppFileHandle {
  name: string;
  file?: File;
  token?: string;
  size?: number;
  mime?: string;
}

/** Aegisub "Open Dummy Video"：纯色/棋盘格背景 + 字幕叠加的合成视频 */
export interface DummyVideoOptions {
  width: number;
  height: number;
  lengthMs: number;
  color: string;
  pattern: boolean;
}

export type SyntheticAudioKind = 'blank' | 'noise';

export interface MediaSource {
  name: string;
  file?: File;
  url: string;
  kind?: 'video' | 'audio';
  dummy?: DummyVideoOptions;
  syntheticAudio?: { kind: SyntheticAudioKind; durationMs: number };
}

export interface HostCapabilities {
  platform: 'browser' | 'webview2' | 'android-webview';
  nativeFileSystem: boolean;
  nativeMedia: boolean;
  opfs: boolean;
  webCodecs: boolean;
}

export interface HostAdapter {
  openFile(types: FileType[]): Promise<AppFileHandle | null>;
  readFile(file: AppFileHandle): Promise<Uint8Array>;
  saveFile(name: string, data: Uint8Array, type?: FileType): Promise<void>;
  openMedia(file: AppFileHandle): Promise<MediaSource>;
  getCapabilities(): HostCapabilities;
}
