/**
 * Automation 脚本持久化。
 *
 * 桌面版脚本来自 autoload 目录扫描（auto4_base.cpp AutoloadScriptManager::Reload
 * L314-332：按 '|' 分列 Path/Automation/Autoload 的多个目录，枚举全部文件，
 * 扩展名筛选交给 ScriptFactory）；web 便携模式下 ?user 与 ?data 同根，
 * 合并为单一目录 /automation/autoload。
 * 「Add」= 把脚本写入该目录（跨会话保留），「Remove」= 删除对应文件
 * （桌面 Remove 仅把脚本移出内存列表、脚本可来自任意路径；web 无外部文件来源，
 * 不删文件会在下次启动被 autoload 重新收录，故为有意偏差）。
 *
 * 旧数据（recent store 的 automation-scripts 键）首次读取时迁移为
 * /automation/autoload/*.lua 并删除旧键（同名文件已存在则保留文件）。
 */
import { openMainDatabase } from './db'
import {
  deletePath,
  fileExists,
  joinPath,
  listDir,
  mkdir,
  readTextFile,
  VFS_DIRS,
  writeTextFile,
} from './vfs'

export interface StoredAutomationScript {
  /** 虚拟绝对路径（兼作唯一 id 与 Reload/Remove 的句柄） */
  id: string
  filename: string
  code: string
}

const LEGACY_STORE = 'recent'
const LEGACY_KEY = 'automation-scripts'

interface LegacyScript {
  id?: string
  filename: string
  code: string
}

async function readLegacyScripts(): Promise<LegacyScript[]> {
  try {
    const database = await openMainDatabase()
    try {
      const value = await new Promise<LegacyScript[] | undefined>((resolve, reject) => {
        const request = database.transaction(LEGACY_STORE).objectStore(LEGACY_STORE).get(LEGACY_KEY)
        request.onsuccess = () => resolve(request.result as LegacyScript[] | undefined)
        request.onerror = () => reject(request.error)
      })
      return Array.isArray(value)
        ? value.filter((script) => script?.filename && typeof script.code === 'string')
        : []
    } finally {
      database.close()
    }
  } catch {
    return []
  }
}

async function clearLegacyScripts(): Promise<void> {
  try {
    const database = await openMainDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LEGACY_STORE, 'readwrite')
        transaction.objectStore(LEGACY_STORE).delete(LEGACY_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
  } catch {
    // 迁移已完成，旧键清理失败不影响使用
  }
}

/** 惰性迁移旧脚本；同名文件已存在时保留现有文件 */
async function migrateLegacyScripts(): Promise<void> {
  const legacy = await readLegacyScripts()
  if (!legacy.length) return
  await mkdir(VFS_DIRS.automationAutoload)
  for (const script of legacy) {
    const path = joinPath(VFS_DIRS.automationAutoload, script.filename)
    // oxlint-disable-next-line no-await-in-loop -- 迁移脚本须逐个写入
    if (await fileExists(path)) continue
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writeTextFile(path, script.code)
  }
  await clearLegacyScripts()
}

/** 枚举 autoload 目录中的 Lua 脚本（web 仅支持 .lua；.moon 需 MoonScript 运行时） */
export async function loadAutomationScripts(): Promise<StoredAutomationScript[]> {
  try {
    await migrateLegacyScripts()
    const entries = await listDir(VFS_DIRS.automationAutoload)
    const scripts: StoredAutomationScript[] = []
    for (const entry of entries) {
      if (entry.directory || !entry.name.toLowerCase().endsWith('.lua')) continue
      // oxlint-disable-next-line no-await-in-loop -- 逐个读取脚本内容
      const code = await readTextFile(entry.path)
      if (code !== null) scripts.push({ id: entry.path, filename: entry.name, code })
    }
    return scripts
  } catch {
    return []
  }
}

/** autoload 目录下的虚拟路径（Add 落盘地址；也是脚本 id） */
export function automationScriptPath(filename: string): string {
  return joinPath(VFS_DIRS.automationAutoload, filename)
}

/** 把脚本写入 autoload 目录（DialogAutomation::OnAdd 的落盘对应物），返回虚拟路径 */
export async function writeAutomationScript(filename: string, code: string): Promise<string> {
  await mkdir(VFS_DIRS.automationAutoload)
  const path = automationScriptPath(filename)
  await writeTextFile(path, code)
  return path
}

/** 删除 autoload 中的脚本文件（Remove） */
export async function removeAutomationScriptFile(path: string): Promise<void> {
  await deletePath(path)
}

/** 重新读取脚本文件（Script::Reload）；不存在返回 null */
export async function readAutomationScriptFile(path: string): Promise<string | null> {
  return readTextFile(path)
}
