/**
 * aegisub-web 主 IndexedDB 库的共享打开器。
 * v3：projects（自动保存）、recent（MRU + Automation 脚本）、fonts（导入的字体）。
 * v4：config（config.json / hotkey.json 持久化）、keyframes（视频关键帧缓存，
 *     对应源码 ?local/ffms2cache/*.ffindex 索引缓存）。
 * 所有访问方必须共用此函数——IndexedDB 版本号是库级共享的，各自 open 不同
 * 版本会互相抛 VersionError。
 */
export const MAIN_DATABASE = 'aegisub-web'
export const MAIN_DATABASE_VERSION = 4

const STORES = ['projects', 'recent', 'fonts', 'config', 'keyframes'] as const

export function openMainDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MAIN_DATABASE, MAIN_DATABASE_VERSION)
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
