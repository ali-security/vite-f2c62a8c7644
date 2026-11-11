import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { PreviewServer, ViteDevServer } from '../../index'
import { createServer, preview } from '../../index'
import { servePublicMiddleware } from '../middlewares/static'

const PUBLIC_CONTENT = 'public-file-content'
const SECRET_CONTENT = 'secret-file-content'

// `http.request` sends the path as-is, so `..` segments reach the server
// (`fetch` would normalize them away)
const request = (port: number, requestPath: string) => {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode!, body })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const listen = (httpServer: http.Server) => {
  return new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve((httpServer.address() as AddressInfo).port)
    })
  })
}

const closeHttpServer = (httpServer: http.Server | undefined) => {
  return new Promise<void>((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
  })
}

// <tmpDir>/
//   root/          vite root (the only `server.fs.allow` entry)
//   out/           served directory (public dir / preview out dir)
//     outfile.txt  legitimately served file
//   outfile.txt    sibling file whose path starts with the served directory path
let tmpDir: string
let root: string
let servedDir: string

beforeAll(() => {
  tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'vite-serve-traversal-')),
  )
  root = path.join(tmpDir, 'root')
  servedDir = path.join(tmpDir, 'out')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(servedDir, { recursive: true })
  fs.writeFileSync(path.join(servedDir, 'outfile.txt'), PUBLIC_CONTENT)
  fs.writeFileSync(path.join(tmpDir, 'outfile.txt'), SECRET_CONTENT)
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 })
})

const traversalPaths = ['/../outfile.txt', '/%2e%2e/outfile.txt']

describe('dev server public dir', () => {
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let rawPublicHttpServer: http.Server | undefined
  let port: number
  let rawPublicPort: number

  beforeAll(async () => {
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      publicDir: servedDir,
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
    port = await listen(httpServer)

    // the public files set is not available when the public dir contains
    // symlinks, then sirv is the only guard of the public dir
    const servePublic = servePublicMiddleware(server)
    rawPublicHttpServer = http.createServer((req, res) => {
      servePublic(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    rawPublicPort = await listen(rawPublicHttpServer)
  })

  afterAll(async () => {
    await closeHttpServer(rawPublicHttpServer)
    await closeHttpServer(httpServer)
    await server?.close()
  })

  test('serves files inside the public dir', async () => {
    const res = await request(port, '/outfile.txt')
    expect(res.status).toBe(200)
    expect(res.body).toBe(PUBLIC_CONTENT)
  })

  for (const traversalPath of traversalPaths) {
    test(`does not serve sibling files starting with the public dir name (${traversalPath})`, async () => {
      const res = await request(port, traversalPath)
      expect(res.status).not.toBe(200)
      expect(res.body).not.toContain(SECRET_CONTENT)
    })

    test(`does not serve sibling files starting with the public dir name without the public files set (${traversalPath})`, async () => {
      const res = await request(rawPublicPort, traversalPath)
      expect(res.status).not.toBe(200)
      expect(res.body).not.toContain(SECRET_CONTENT)
    })
  }
})

describe('preview server', () => {
  let server: PreviewServer | undefined
  let port: number

  beforeAll(async () => {
    server = await preview({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'mpa',
      build: {
        outDir: path.relative(root, servedDir),
      },
      preview: {
        host: '127.0.0.1',
        port: 0,
      },
    })
    port = (server.httpServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    await server?.close()
  })

  test('serves files inside the out dir', async () => {
    const res = await request(port, '/outfile.txt')
    expect(res.status).toBe(200)
    expect(res.body).toBe(PUBLIC_CONTENT)
  })

  for (const traversalPath of traversalPaths) {
    test(`does not serve sibling files starting with the out dir name (${traversalPath})`, async () => {
      const res = await request(port, traversalPath)
      expect(res.status).not.toBe(200)
      expect(res.body).not.toContain(SECRET_CONTENT)
    })
  }
})
