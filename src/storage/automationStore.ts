/**
 * Automation 脚本持久化。
 *
 * 桌面版脚本分两类（auto4_base.cpp）：
 * - 全局：扫描 autoload 目录（AutoloadScriptManager::Reload L314-332），列表标记 G；
 * - 本地：字幕文件的 [Aegisub Project Garbage] / Automation Scripts 字段引用，
 *   打开文件时询问信任后加载（LocalScriptManager::Reload L368-443），标记 L。
 *
 * web 便携模式下 ?user 与 ?data 同根，全局目录合并为 /automation/autoload；
 * 本地脚本没有桌面那样的外部路径，Add 时写入 /automation/local，
 * 并把虚拟路径以 `$local/<name>`（相对 Automation Base）或 `/绝对路径` 记入项目属性。
 * 注意：脚本正文只存在当前浏览器的 IndexedDB 里，.ass 文件本身不内嵌脚本；
 * 换设备/浏览器打开带 `$local/...` 引用的字幕时会提示脚本缺失并跳过
 * （桌面版是随项目分发的真实文件，没有这个限制）。
 */
import { openMainDatabase } from './db'
import { fileExists, joinPath, listDir, mkdir, readTextFile, VFS_DIRS, writeTextFile } from './vfs'

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

/** 枚举 autoload 目录中的 Lua / MoonScript 脚本（auto4_lua.cpp 的 "*.lua,*.moon"） */
export async function loadAutomationScripts(): Promise<StoredAutomationScript[]> {
  try {
    await migrateLegacyScripts()
    const entries = await listDir(VFS_DIRS.automationAutoload)
    const scripts: StoredAutomationScript[] = []
    for (const entry of entries) {
      if (entry.directory || !/\.(lua|moon)$/i.test(entry.name)) continue
      // oxlint-disable-next-line no-await-in-loop -- 逐个读取脚本内容
      const code = await readTextFile(entry.path)
      if (code !== null) scripts.push({ id: entry.path, filename: entry.name, code })
    }
    return scripts
  } catch {
    return []
  }
}

/** 本地（项目内）脚本在 VFS 中的路径（Automation Scripts 的落盘地址 / 脚本 id） */
export function automationLocalScriptPath(filename: string): string {
  return joinPath(VFS_DIRS.automationLocal, filename)
}

/** 把 Add 载入的脚本写入 /automation/local，返回虚拟路径 */
export async function writeLocalAutomationScript(filename: string, code: string): Promise<string> {
  await mkdir(VFS_DIRS.automationLocal)
  const path = automationLocalScriptPath(filename)
  await writeTextFile(path, code)
  return path
}

/** 重新读取脚本文件（Script::Reload）；不存在返回 null */
export async function readAutomationScriptFile(path: string): Promise<string | null> {
  return readTextFile(path)
}
