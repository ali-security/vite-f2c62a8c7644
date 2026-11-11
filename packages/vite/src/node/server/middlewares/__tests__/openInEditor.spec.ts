import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ViteDevServer } from '../../index'
import { createServer } from '../../index'
import { isWindows } from '../../../../shared/utils'
import { isWindowsUNCPath } from '../openInEditor'

const UNC_ERROR =
  'UNC paths are not supported on Windows to avoid security issues.'

describe('isWindowsUNCPath', () => {
  const uncPaths = [
    '\\\\server\\share\\file.js',
    '//server/share/file.js',
    '/\\server\\share/file.js',
    '\\\\server\\share\\file.js:10',
    '\\\\server\\share\\file.js:10:5',
    '//server/share/file.js:10:5',
    '\\\\192.168.0.1\\share\\file.js',
    '\\\\server@SSL\\share\\file.js',
    '\\\\?\\UNC\\server\\share\\file.js',
  ]
  test.each(uncPaths)('%s is a UNC path', (file) => {
    expect(isWindowsUNCPath(file)).toBe(true)
  })

  const nonUncPaths = [
    'src/main.ts',
    'src\\main.ts',
    'src/main.ts:10:5',
    './src/main.ts',
    '/home/user/project/src/main.ts',
    'C:\\Users\\user\\project\\src\\main.ts',
    'C:/Users/user/project/src/main.ts',
    'C:\\Users\\user\\project\\src\\main.ts:10:5',
  ]
  test.each(nonUncPaths)('%s is not a UNC path', (file) => {
    expect(isWindowsUNCPath(file)).toBe(false)
  })
})

describe('open in editor middleware', () => {
  let tmpDir: string
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

  const uncRequests = [
    '/__open-in-editor?file=\\\\server\\share\\file.js',
    '/__open-in-editor?file=//server/share/file.js',
    '/__open-in-editor?file=\\\\server\\share\\file.js:10:5',
    '/__open-in-editor?file=does-not-exist.js&file=\\\\server\\share\\file.js',
    '/__open-in-editor?foo=bar?&file=\\\\server\\share\\file.js',
  ]

  beforeAll(async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vite-open-in-editor-')),
    )
    server = await createServer({
      root: tmpDir,
      configFile: false,
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
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

  test.runIf(isWindows).each(uncRequests)(
    'should reject UNC paths on Windows: %s',
    async (requestTarget) => {
      const response = await sendRawRequest(requestTarget)
      expect(response).toContain('HTTP/1.1 403')
      expect(response).toContain(UNC_ERROR)
    },
  )

  test.skipIf(isWindows).each(uncRequests)(
    'should not apply the UNC path guard on non-Windows platforms: %s',
    async (requestTarget) => {
      const response = await sendRawRequest(requestTarget)
      expect(response).not.toContain('HTTP/1.1 403')
      expect(response).not.toContain(UNC_ERROR)
    },
  )

  test('should pass non-UNC paths to launch-editor', async () => {
    const response = await sendRawRequest(
      '/__open-in-editor?file=src/does-not-exist-xyz.js:10:5',
    )
    expect(response).toContain('HTTP/1.1 200')
    expect(response).not.toContain(UNC_ERROR)
  })

  test('should pass requests without a file to launch-editor', async () => {
    const response = await sendRawRequest('/__open-in-editor')
    expect(response).toContain('HTTP/1.1 500')
    expect(response).toContain('required query param "file" is missing')
    expect(response).not.toContain(UNC_ERROR)
  })
})
