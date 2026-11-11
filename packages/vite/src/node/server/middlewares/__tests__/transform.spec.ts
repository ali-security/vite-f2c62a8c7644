import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ViteDevServer } from '../../index'
import { createServer } from '../../index'

describe('optimized deps sourcemap handler', () => {
  let tmpDir: string
  let root: string
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let port: number

  const sendRawRequest = (requestTarget: string) => {
    return new Promise<string>((resolve, reject) => {
      const buf: Buffer[] = []
      const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
        client.write(
          [
            `GET ${encodeURI(requestTarget)} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Connection: Close',
            '\r\n',
          ].join('\r\n'),
        )
      })
      client.on('data', (data) => {
        buf.push(data)
      })
      client.on('end', () => {
        resolve(Buffer.concat(buf).toString())
      })
      client.on('error', (err) => {
        reject(err)
      })
    })
  }

  beforeAll(async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vite-transform-sourcemap-')),
    )
    // the deps cache dir lives inside root, so optimized deps are requested
    // with `/node_modules/.vite/deps/` urls (not `/@fs/` urls)
    root = path.join(tmpDir, 'root')
    fs.mkdirSync(root, { recursive: true })
    // valid sourcemap file outside of root and outside of the deps cache dir
    fs.writeFileSync(
      path.join(tmpDir, 'unsafe.map'),
      JSON.stringify({
        version: 3,
        sources: ['unsafe.js'],
        sourcesContent: ['KEY=unsafe'],
        names: [],
        mappings: 'AAAA',
      }),
    )

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'node_modules/.vite'),
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
        fs: {
          strict: true,
          allow: [root],
        },
      },
    })
    httpServer = http.createServer(server.middlewares)
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => resolve())
    })
    port = (httpServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    }
    await server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
  })

  test('should handle sourcemap requests inside the optimized deps directory', async () => {
    // outdated sourcemap request inside the deps cache dir falls back to a dummy sourcemap
    const response = await sendRawRequest(
      '/node_modules/.vite/deps/missing.js.map',
    )
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('Cache-Control: no-cache')
    expect(response).toContain('"mappings":";;;;;;;;;"')
  })

  test('should not allow relative path traversal outside of the optimized deps directory', async () => {
    const response = await sendRawRequest(
      '/node_modules/.vite/deps/../../../../unsafe.map',
    )
    expect(response).not.toContain('HTTP/1.1 200 OK')
    expect(response).not.toContain('KEY=unsafe')
  })

  test('should not respond with a dummy sourcemap for paths outside of the optimized deps directory', async () => {
    const response = await sendRawRequest(
      '/node_modules/.vite/deps/../../../../missing.js.map',
    )
    expect(response).not.toContain('HTTP/1.1 200 OK')
    expect(response).not.toContain('"mappings":";;;;;;;;;"')
  })
})

describe('server.fs checks for transformed requests', () => {
  let tmpDir: string
  let root: string
  let fsRoot: string
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let port: number

  const sendRawRequest = (requestTarget: string) => {
    return new Promise<string>((resolve, reject) => {
      const buf: Buffer[] = []
      const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
        client.write(
          [
            `GET ${encodeURI(requestTarget)} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Connection: Close',
            '\r\n',
          ].join('\r\n'),
        )
      })
      client.on('data', (data) => {
        buf.push(data)
      })
      client.on('end', () => {
        resolve(Buffer.concat(buf).toString())
      })
      client.on('error', (err) => {
        reject(err)
      })
    })
  }

  beforeAll(async () => {
    // use the native realpath so that Windows 8.3 short names in the temp dir
    // are expanded and do not trip the short name check of `server.fs`
    tmpDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vite-transform-fs-')),
    )
    root = path.join(tmpDir, 'root')
    const src = path.join(root, 'src')
    fs.mkdirSync(src, { recursive: true })
    // inside `server.fs.allow`
    fs.writeFileSync(path.join(src, 'safe.txt'), 'KEY=safe')
    fs.writeFileSync(
      path.join(src, 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    fs.writeFileSync(
      path.join(src, 'main.js'),
      `import raw from './safe.txt?raw'\nimport icon from './icon.svg'\nexport { raw, icon }\n`,
    )
    // denied by the default `server.fs.deny`
    fs.writeFileSync(path.join(src, '.env'), 'KEY=dotenv')
    // inside root, but outside of `server.fs.allow`
    fs.writeFileSync(path.join(root, 'unsafe.txt'), 'KEY=unsafe')
    fs.writeFileSync(
      path.join(root, 'unsafe.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    fsRoot = path.posix.join('/@fs/', root.replace(/\\/g, '/'))

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'node_modules/.vite'),
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
        fs: {
          strict: true,
          allow: [src],
        },
      },
      plugins: [
        {
          name: 'svg-virtual-module',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'virtual:foo.svg') {
              return '\0virtual:foo.svg'
            }
          },
          load(id) {
            if (id === '\0virtual:foo.svg') {
              return `export default '<svg><rect width="100" height="100"></svg>'`
            }
          },
        },
      ],
    })
    httpServer = http.createServer(server.middlewares)
    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => resolve())
    })
    port = (httpServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    }
    await server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
  })

  test('should allow raw import of a file inside the allow list', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/safe.txt?import&raw`)
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('KEY=safe')
  })

  test('should allow svg import of a file inside the allow list', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/icon.svg?import`)
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('export default')
  })

  test('should allow imports recorded by an importer', async () => {
    const main = await sendRawRequest('/src/main.js')
    expect(main).toContain('HTTP/1.1 200 OK')

    const svg = await sendRawRequest('/src/icon.svg?import')
    expect(svg).toContain('HTTP/1.1 200 OK')
    expect(svg).toContain('export default')

    const raw = await sendRawRequest('/src/safe.txt?import&raw')
    expect(raw).toContain('HTTP/1.1 200 OK')
    expect(raw).toContain('KEY=safe')
  })

  test('should allow virtual svg modules', async () => {
    const response = await sendRawRequest('/@id/__x00__virtual:foo.svg?import')
    expect(response).toContain('HTTP/1.1 200 OK')
    expect(response).toContain('<svg')
  })

  test('should not allow relative path after query with /@fs/', async () => {
    const response = await sendRawRequest(
      `${fsRoot}/src/?/../../unsafe.txt?import&raw`,
    )
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe')

    const response2 = await sendRawRequest(
      `${fsRoot}/src/?/../../unsafe.txt?import&?raw`,
    )
    expect(response2).toContain('HTTP/1.1 403 Forbidden')
    expect(response2).not.toContain('KEY=unsafe')
  })

  test('should not allow relative path after query of an imported file', async () => {
    const main = await sendRawRequest('/src/main.js')
    expect(main).toContain('HTTP/1.1 200 OK')

    const response = await sendRawRequest(
      '/src/safe.txt?/../../unsafe.txt?import&raw',
    )
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe')
  })

  test('should respond to concurrent requests of a denied id', async () => {
    const target = `${fsRoot}/src/?/../../unsafe.txt?raw&import`
    const responses = await Promise.all([
      sendRawRequest(target),
      sendRawRequest(target),
    ])
    for (const response of responses) {
      expect(response).toContain('HTTP/1.1 403 Forbidden')
      expect(response).not.toContain('KEY=unsafe')
    }
  })

  test('should not allow svg import outside of the allow list', async () => {
    const response = await sendRawRequest('/unsafe.svg?import')
    expect(response).toContain('HTTP/1.1 403 Forbidden')

    const response2 = await sendRawRequest(`${fsRoot}/unsafe.svg?import`)
    expect(response2).toContain('HTTP/1.1 403 Forbidden')
  })

  test('should not allow .svg query outside of the allow list', async () => {
    const response = await sendRawRequest('/unsafe.txt?.svg?import')
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=unsafe')

    const response2 = await sendRawRequest(`${fsRoot}/unsafe.txt?.svg?import`)
    expect(response2).toContain('HTTP/1.1 403 Forbidden')
    expect(response2).not.toContain('KEY=unsafe')
  })

  test('should not allow denied files with ?.svg?.wasm?init', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/.env?.svg?.wasm?init`)
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=dotenv')
  })

  test('should not treat .wasm?init inside the query as wasm init', async () => {
    const response = await sendRawRequest(`${fsRoot}/src/.env?.wasm?init`)
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=dotenv')
  })

  test('should not allow denied files with a query', async () => {
    const queries = [
      '?raw',
      '?import&raw',
      '?import&url',
      '?import&inline',
      '?import&.svg',
    ]
    for (const query of queries) {
      const response = await sendRawRequest(`${fsRoot}/src/.env${query}`)
      expect(response, query).toContain('HTTP/1.1 403 Forbidden')
      expect(response, query).not.toContain('KEY=dotenv')
    }
  })

  test('should not allow relative path after query to a denied file', async () => {
    const response = await sendRawRequest(
      `${fsRoot}/src/safe.txt?/../.env?import&raw`,
    )
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(response).not.toContain('KEY=dotenv')
  })
})
