/**
 * 出厂 Automation 脚本内联与安装。
 *
 * 桌面版脚本来自安装目录的 `automation/autoload` 与 `automation/include`
 * （meson.build 的 install 目标）。Web 版把这两个目录的出厂脚本用 Vite 的
 * `import.meta.glob`（默认 lazy、非 eager）内联进产物，首次启动安装到 VFS 的
 * `/automation/autoload`、`/automation/include`；「还原默认」可随时把出厂内容
 * 重新写出。
 *
 * 跳过 `.moon`（web 无 MoonScript 运行时，见 auto4_base.cpp 的 ScriptFactory 分支）
 * 与 `moonscript.lua`（MoonScript 编译器，缺少 .moon 支持后无引用方）。
 * 首次安装判定用标记文件而非「目录为空」，避免用户删光脚本后又被自动复活。
 */
import { basename, fileExists, joinPath, mkdir, VFS_DIRS, writeTextFile } from './vfs'

type RawLoader = () => Promise<unknown>

const autoloadLoaders = import.meta.glob('../../Aegisub/automation/autoload/*.lua', {
  query: '?raw',
  import: 'default',
}) as Record<string, RawLoader>

const includeLoaders = import.meta.glob('../../Aegisub/automation/include/**/*.lua', {
  query: '?raw',
  import: 'default',
}) as Record<string, RawLoader>

/** 出厂脚本目录的安装标记（存在即视为已安装过） */
const FACTORY_MARKER = '/automation/.factory-scripts'

/** MoonScript 编译器：无 .moon 支持时无用，跳过以免白白增大产物 */
const SKIP_FILES = new Set(['moonscript.lua'])

function fileNameOf(key: string): string {
  return key.split('/').pop() ?? key
}

/** `.../automation/include/<rel>` → `<rel>`（保留 aegisub/ 等子目录） */
function includeRelativePath(key: string): string | null {
  const marker = '/automation/include/'
  const index = key.lastIndexOf(marker)
  return index === -1 ? null : key.slice(index + marker.length)
}

/** 把内联的出厂脚本写入 VFS（覆盖同名文件；不删除用户自建脚本） */
export async function restoreFactoryScripts(): Promise<void> {
  await mkdir(VFS_DIRS.automationAutoload)
  await mkdir(VFS_DIRS.automationInclude)
  for (const [key, load] of Object.entries(autoloadLoaders)) {
    const name = fileNameOf(key)
    if (SKIP_FILES.has(name)) continue
    // oxlint-disable-next-line no-await-in-loop -- 出厂脚本须逐个写入
    const code = String(await load())
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writeTextFile(joinPath(VFS_DIRS.automationAutoload, name), code)
  }
  for (const [key, load] of Object.entries(includeLoaders)) {
    const relative = includeRelativePath(key)
    if (!relative || SKIP_FILES.has(basename(relative))) continue
    // oxlint-disable-next-line no-await-in-loop -- 出厂脚本须逐个写入
    const code = String(await load())
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writeTextFile(joinPath(VFS_DIRS.automationInclude, relative), code)
  }
}

/** 首次启动安装出厂脚本（幂等：标记文件存在即跳过） */
export async function installFactoryScripts(): Promise<void> {
  try {
    if (await fileExists(FACTORY_MARKER)) return
    await restoreFactoryScripts()
    await writeTextFile(FACTORY_MARKER, 'installed\n')
  } catch {
    // 安装失败不阻塞启动（下次启动会重试）
  }
}
