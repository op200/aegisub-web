import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'

const repository = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env?.PAGES_REPO

/**
 * 多语言 po 直接引用源码目录 Aegisub/po（仓库内零副本）：
 *   - dev：middleware 把 /locales 下的 po 与 LINGUAS 请求映射到源码文件
 *   - build：generateBundle 时原样 emit 到 dist/locales（部署后运行时按需 fetch）
 * 源码 po 更新即生效：dev 即时、build 随新构建。
 */
function poLocalesPlugin(): Plugin {
  const poDir = path.resolve(import.meta.dirname, 'Aegisub/po')
  const poNames = (): string[] =>
    readdirSync(poDir).filter((name) => name === 'LINGUAS' || name.endsWith('.po'))

  return {
    name: 'aegisub-po-locales',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // 结尾匹配，兼容 dev server 是否带 base 前缀（'/' 或 '/repo/'）
        const url = (req.url ?? '').split('?')[0]
        const match = url.match(/\/locales\/([\w@.-]+\.po|LINGUAS)$/)
        if (!match) return next()
        try {
          const data = readFileSync(path.join(poDir, decodeURIComponent(match[1])))
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
          })
          res.end(data)
        } catch {
          res.writeHead(404)
          res.end()
        }
      })
    },
    generateBundle() {
      // fileName 相对 dist 根目录，与 base 无关（部署时由 base 前缀目录承载）
      for (const name of poNames()) {
        this.emitFile({
          type: 'asset',
          fileName: `locales/${name}`,
          source: readFileSync(path.join(poDir, name), 'utf-8'),
        })
      }
    },
  }
}

/**
 * fengari 同时面向 Node 与浏览器：源码里有 `require('fs'/'path'/'os'/'crypto'/
 * 'child_process')` 以及 Node 专用依赖 tmp / readline-sync。这些分支在浏览器里
 * 都被 `typeof process` 守卫，不会执行，但 rolldown 仍会解析它们并对每个 Node
 * 内置模块告警「externalized for browser compatibility」。
 *
 * 构建期把 fengari 链路上的这些模块替换成空模块（运行时分支本就不执行，行为不变），
 * 顺带把 tmp / readline-sync 的 Node 代码移出产物。仅作用于 build，dev / Vitest
 * 仍走 Node 原生模块（Lua 测试依赖真实 fs）。
 */
function fengariNodeStubPlugin(): Plugin {
  const STUBBED = new Set(['fs', 'path', 'os', 'crypto', 'child_process', 'tmp', 'readline-sync'])
  const VIRTUAL_ID = '\0aegisub-node-stub'

  return {
    name: 'aegisub-fengari-node-stub',
    apply: 'build',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!STUBBED.has(id)) return
      if (!importer || !/(fengari|readline-sync|tmp)[\\/]/.test(importer)) return
      return VIRTUAL_ID
    },
    load(id) {
      if (id === VIRTUAL_ID) return 'export default {}'
    },
  }
}

export default defineConfig({
  base: repository ? `/${repository}/` : './',
  plugins: [react(), poLocalesPlugin(), fengariNodeStubPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // 首屏静态依赖链（React + 应用代码）约 870 kB，超过默认 500 kB 警告阈值。
    // 不能按 maxSize 再分包：rolldown 会把存在循环引用的模块拆到不同 chunk，
    // 各 chunk 以 <script type="module"> 独立执行时互相读到未初始化的导出
    // （表现为 Object.keys(undefined) 白屏，vite 8.3.8 起必现）。
    chunkSizeWarningLimit: 1000,
  },
  worker: {
    format: 'es',
  },
  server: {
    watch: {
      // Aegisub 源码、native/（含 boost 17 万文件）不参与监听，避免拖垮 dev server
      ignored: ['**/Aegisub/**', '**/native/**', '**/test-results/**'],
    },
  },
  // vitest 只跑单元测试；tests/e2e 归 Playwright
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    setupFiles: ['tests/setup.ts'],
  },
})
