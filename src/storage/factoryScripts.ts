/**
 * 出厂 Automation 脚本内联与安装。
 *
 * 桌面版脚本来自安装目录的 `automation/autoload` 与 `automation/include`
 * （meson.build 的 install 目标）。Web 版把这两个目录的出厂脚本用 Vite 的
 * `import.meta.glob`（默认 lazy、非 eager）内联进产物，首次启动安装到 VFS 的
 * `/automation/autoload`、`/automation/include`；「还原默认」可随时把出厂内容
 * 重新写出。
 *
 * 跳过 include 目录的 `.moon`（aegisub/*.moon 内部模块已有 Lua 移植，且依赖
 * lpeg/ffi）与 `moonscript.lua`（桌面版的 0.7 编译器；web 使用 src/automation/
 * moonscript 里的 0.8 纯 Lua 解析器版本）。
 * 首次安装判定用标记文件而非「目录为空」，避免用户删光脚本后又被自动复活；
 * 标记内容带清单版本，版本变化时只补装缺失文件（不覆盖用户改过的脚本）。
 */
import { basename, fileExists, joinPath, mkdir, readTextFile, VFS_DIRS, writeTextFile } from './vfs'

type RawLoader = () => Promise<unknown>

const autoloadLoaders = import.meta.glob('../../Aegisub/automation/autoload/*.{lua,moon}', {
  query: '?raw',
  import: 'default',
}) as Record<string, RawLoader>

const includeLoaders = import.meta.glob('../../Aegisub/automation/include/**/*.lua', {
  query: '?raw',
  import: 'default',
}) as Record<string, RawLoader>

/** 出厂脚本目录的安装标记；内容为清单版本，版本变化时补装新增脚本 */
const FACTORY_MARKER = '/automation/.factory-scripts'
const FACTORY_MARKER_CONTENT = 'installed-2\n'

/** 桌面版自带的 MoonScript 0.7 编译器：web 改用 vendored 0.8（不需要 lpeg），跳过以免增大产物 */
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

/** 把内联的出厂脚本写入 VFS（overwrite=false 时跳过已存在的同名文件） */
async function writeFactoryScripts(overwrite: boolean): Promise<void> {
  await mkdir(VFS_DIRS.automationAutoload)
  await mkdir(VFS_DIRS.automationInclude)
  for (const [key, load] of Object.entries(autoloadLoaders)) {
    const name = fileNameOf(key)
    if (SKIP_FILES.has(name)) continue
    const target = joinPath(VFS_DIRS.automationAutoload, name)
    // oxlint-disable-next-line no-await-in-loop -- 补装模式须逐个检查
    if (!overwrite && (await fileExists(target))) continue
    // oxlint-disable-next-line no-await-in-loop -- 出厂脚本须逐个写入
    const code = String(await load())
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writeTextFile(target, code)
  }
  for (const [key, load] of Object.entries(includeLoaders)) {
    const relative = includeRelativePath(key)
    if (!relative || SKIP_FILES.has(basename(relative))) continue
    const target = joinPath(VFS_DIRS.automationInclude, relative)
    // oxlint-disable-next-line no-await-in-loop -- 补装模式须逐个检查
    if (!overwrite && (await fileExists(target))) continue
    // oxlint-disable-next-line no-await-in-loop -- 出厂脚本须逐个写入
    const code = String(await load())
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await writeTextFile(target, code)
  }
}

/** 把内联的出厂脚本写入 VFS（覆盖同名文件；不删除用户自建脚本） */
export async function restoreFactoryScripts(): Promise<void> {
  await writeFactoryScripts(true)
}

/** 首次启动安装出厂脚本；清单版本升级时只补装缺失文件（幂等） */
export async function installFactoryScripts(): Promise<void> {
  try {
    if ((await readTextFile(FACTORY_MARKER)) === FACTORY_MARKER_CONTENT) return
    await writeFactoryScripts(false)
    await writeTextFile(FACTORY_MARKER, FACTORY_MARKER_CONTENT)
  } catch {
    // 安装失败不阻塞启动（下次启动会重试）
  }
}
