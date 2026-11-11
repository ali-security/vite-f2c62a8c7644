import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer, resolveConfig } from '..'
import type { ViteDevServer } from '..'
import { isFileLoadingAllowed } from '../server/middlewares/static'
import { normalizePath } from '../utils'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('resolveBuildOptions in dev', () => {
  test('build.rollupOptions should not have input in lib', async () => {
    const config = await resolveConfig(
      {
        build: {
          lib: {
            entry: './index.js',
          },
        },
      },
      'serve',
    )

    expect(config.build.rollupOptions).not.toHaveProperty('input')
  })
})

describe('the dev server', () => {
  let server: ViteDevServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('does not mark unresolved SSR imports as safe', async () => {
    const root = __dirname
    const entry = normalizePath(path.join(root, 'unresolved-entry.js'))
    const unresolvedImport = '/safe-module-path-unresolved'

    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
      plugins: [
        {
          name: 'unresolved-ssr-import',
          resolveId(id) {
            if (id === '/unresolved-entry.js') return entry
          },
          load(id) {
            if (id === entry)
              return `import ${JSON.stringify(unresolvedImport)}`
          },
        },
      ],
    })

    await server.transformRequest('/unresolved-entry.js', { ssr: true })

    expect(server.moduleGraph.safeModulesPath).not.toContain(unresolvedImport)
  })

  test('marks the resolved id as safe instead of the url', async () => {
    const root = __dirname
    const entry = normalizePath(path.join(root, 'confusion-entry.js'))
    // a module inside root whose root-relative url looks like an
    // absolute path to a file outside of `server.fs.allow`
    const target = '/safe-module-path-outside/secret.txt'
    const decoyId = normalizePath(root) + target

    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
      plugins: [
        {
          name: 'safe-module-path-confusion',
          enforce: 'pre',
          resolveId(id) {
            if (id === '/confusion-entry.js') return entry
            if (id === 'virtual:safe-module-path-confusion') return decoyId
          },
          load(id) {
            if (id === entry)
              return `import 'virtual:safe-module-path-confusion'`
            if (id === decoyId) return 'export {}'
          },
        },
      ],
    })

    await server.transformRequest('/confusion-entry.js')

    expect(server.moduleGraph.safeModulesPath).toContain(decoyId)
    expect(server.moduleGraph.safeModulesPath).not.toContain(target)
    expect(isFileLoadingAllowed(server, target)).toBe(false)
  })
})
