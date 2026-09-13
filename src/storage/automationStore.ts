/**
 * Automation 脚本持久化（对应 Aegisub 的 LocalScriptManager：脚本列表随工程保存；
 * Web 版存 IndexedDB，跨会话保留）。
 */
import { openMainDatabase } from './db'

export interface StoredAutomationScript {
  id: string
  filename: string
  code: string
}

const STORE = 'recent'
const KEY = 'automation-scripts'

export async function loadAutomationScripts(): Promise<StoredAutomationScript[]> {
  try {
    const database = await openMainDatabase()
    const value = await new Promise<StoredAutomationScript[] | undefined>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result as StoredAutomationScript[] | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export async function saveAutomationScripts(scripts: StoredAutomationScript[]): Promise<void> {
  try {
    const database = await openMainDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(scripts, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // 私密模式下不可用：仅内存保留
  }
}
