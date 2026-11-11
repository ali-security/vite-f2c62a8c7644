import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { FS_PREFIX } from '../../../constants'
import { createServer } from '../../../server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures')
const HTML_PATH = path.resolve(FIXTURE_DIR, 'root/index.html')
const HTML_CONTENT = fs.readFileSync(HTML_PATH, 'utf-8')
const OUTSIDE_HTML_PATH = path.resolve(FIXTURE_DIR, 'outside.html')
const OUTSIDE_HTML_CONTENT = fs.readFileSync(OUTSIDE_HTML_PATH, 'utf-8')
const VITE_PACKAGE_DIR = path.resolve(__dirname, '../../../../..')

async function createTestServer(rootDir?: string) {
  const root = path.resolve(__dirname, rootDir ?? 'fixtures/root')

  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    server: {
      middlewareMode: true,
      ws: false,
    },
    optimizeDeps: {
      noDiscovery: true,
      include: [],
    },
  })

  onTestFinished(() => server.close())
  return server
}

describe('indexHtml middleware — inline script proxy cache', () => {
  test('inline module script loads via html-proxy', async () => {
    const server = await createTestServer('fixtures/root')
    const url = '/index.html'

    const transformed = await server.transformIndexHtml(url, HTML_CONTENT)

    expect(transformed).toContain('html-proxy')
    expect(transformed).toContain('index=0')

    const proxyUrlMatch = transformed.match(/src="([^"]*html-proxy[^"]*)"/)
    expect(
      proxyUrlMatch,
      'devHtmlHook should rewrite the inline <script> to a ?html-proxy src',
    ).toBeTruthy()

    const proxyModuleUrl = proxyUrlMatch![1]
    expect(proxyModuleUrl).toBe('/index.html?html-proxy&index=0.js')
    const result = await server.transformRequest(proxyModuleUrl)

    expect(result, 'proxy module should resolve without error').not.toBeNull()
    expect(result!.code).toContain('module loaded')
  })

  for (const prefix of ['//', '///']) {
    test(`does not keep a protocol-relative URL (${prefix})`, async () => {
      const server = await createTestServer(VITE_PACKAGE_DIR)
      const url = prefix + 'evil.example.com/payload.js?/../../package.json'

      const transformed = await server.transformIndexHtml(url, HTML_CONTENT)
      const proxyUrlMatch = transformed.match(/src="([^"]*html-proxy[^"]*)"/)

      expect(
        proxyUrlMatch,
        'devHtmlHook should have rewritten the inline <script> to a ?html-proxy src',
      ).toBeTruthy()
      expect(proxyUrlMatch![1]).toMatchInlineSnapshot(
        `"/@id/__x00__/evil.example.com/payload.js?/../../package.json?html-proxy&index=0.js"`,
      )
      expect(proxyUrlMatch![1]).not.toMatch(/^\/\//)
      expect(transformed).not.toMatch(/src="\/\/evil\.example\.com/)
    })

    test(`normalizes a protocol-relative html path (${prefix})`, async () => {
      const server = await createTestServer()
      const html = HTML_CONTENT.replace(
        '</head>',
        '<style>body { color: red; }</style></head>',
      )

      const transformed = await server.transformIndexHtml(
        prefix + 'index.html',
        html,
      )

      expect(transformed).toContain('src="/index.html?html-proxy&index=0.js"')
      expect(transformed).not.toContain('src="//')
      const urlMap = server.moduleGraph.urlToModuleMap
      const cssUrl = '/index.html?html-proxy&direct&index=0.css'
      expect(urlMap.has(cssUrl)).toBe(true)
      expect(urlMap.has('/' + cssUrl)).toBe(false)
    })
  }
})

describe('indexHtml middleware — file watching', () => {
  test('watches an /@fs/ HTML file outside root', async () => {
    const server = await createTestServer()
    const addSpy = vi
      .spyOn(server.watcher, 'add')
      .mockImplementation(() => server.watcher)
    const fsUrl = path.posix.join(FS_PREFIX, OUTSIDE_HTML_PATH)

    await server.transformIndexHtml(fsUrl, OUTSIDE_HTML_CONTENT)

    expect(addSpy).toHaveBeenCalledWith(OUTSIDE_HTML_PATH)
  })

  test('does not watch a directory for a root URL with a query', async () => {
    const server = await createTestServer()
    const addSpy = vi
      .spyOn(server.watcher, 'add')
      .mockImplementation(() => server.watcher)
    const html = '<style>body { color: red; }</style>'

    await server.transformIndexHtml('/?foo=bar', html)

    expect(addSpy).not.toHaveBeenCalledWith('/')
  })
})
