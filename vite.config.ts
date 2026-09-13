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

export default defineConfig({
  base: repository ? `/${repository}/` : './',
  plugins: [react(), poLocalesPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
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
