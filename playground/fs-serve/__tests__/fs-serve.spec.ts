import net from 'node:net'
import path from 'node:path'
import fetch from 'node-fetch'
import { beforeAll, describe, expect, test } from 'vitest'
import testJSON from '../safe.json'
import { getWindows83ShortNameForDotEnv } from '../root/windows83Filename'
import { isServe, isWindows, page, viteTestUrl } from '~utils'

const stringified = JSON.stringify(testJSON)

describe.runIf(isServe)('main', () => {
  beforeAll(async () => {
    const srcPrefix = viteTestUrl.endsWith('/') ? '' : '/'
    await page.goto(viteTestUrl + srcPrefix + 'src/')
  })

  test('default import', async () => {
    expect(await page.textContent('.full')).toBe(stringified)
  })

  test('named import', async () => {
    expect(await page.textContent('.named')).toBe(testJSON.msg)
  })

  test('safe fetch', async () => {
    expect(await page.textContent('.safe-fetch')).toMatch('KEY=safe')
    expect(await page.textContent('.safe-fetch-status')).toBe('200')
  })

  test('safe fetch with query', async () => {
    expect(await page.textContent('.safe-fetch-query')).toMatch('KEY=safe')
    expect(await page.textContent('.safe-fetch-query-status')).toBe('200')
  })

  test('safe fetch with special characters', async () => {
    expect(
      await page.textContent('.safe-fetch-subdir-special-characters'),
    ).toMatch('KEY=safe')
    expect(
      await page.textContent('.safe-fetch-subdir-special-characters-status'),
    ).toBe('200')
  })

  test('unsafe fetch', async () => {
    expect(await page.textContent('.unsafe-fetch')).toMatch('403 Restricted')
    expect(await page.textContent('.unsafe-fetch-status')).toBe('403')
  })

  test('unsafe fetch with special characters (#8498)', async () => {
    expect(await page.textContent('.unsafe-fetch-8498')).toBe('')
    expect(await page.textContent('.unsafe-fetch-8498-status')).toBe('404')
  })

  test('unsafe fetch with special characters 2 (#8498)', async () => {
    expect(await page.textContent('.unsafe-fetch-8498-2')).toBe('')
    expect(await page.textContent('.unsafe-fetch-8498-2-status')).toBe('404')
  })

  test('unsafe fetch import inline', async () => {
    expect(await page.textContent('.unsafe-fetch-import-inline-status')).toBe(
      '403',
    )
  })

  test('unsafe fetch raw query import', async () => {
    expect(
      await page.textContent('.unsafe-fetch-raw-query-import-status'),
    ).toBe('403')
  })

  test('safe fs fetch', async () => {
    expect(await page.textContent('.safe-fs-fetch')).toBe(stringified)
    expect(await page.textContent('.safe-fs-fetch-status')).toBe('200')
  })

  test('safe fs fetch', async () => {
    expect(await page.textContent('.safe-fs-fetch-query')).toBe(stringified)
    expect(await page.textContent('.safe-fs-fetch-query-status')).toBe('200')
  })

  test('safe fs fetch with special characters', async () => {
    expect(await page.textContent('.safe-fs-fetch-special-characters')).toBe(
      stringified,
    )
    expect(
      await page.textContent('.safe-fs-fetch-special-characters-status'),
    ).toBe('200')
  })

  test('unsafe fs fetch', async () => {
    expect(await page.textContent('.unsafe-fs-fetch')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-status')).toBe('403')
  })

  test('unsafe fs fetch', async () => {
    expect(await page.textContent('.unsafe-fs-fetch-raw')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-raw-status')).toBe('403')
  })

  test('unsafe fs fetch query 1', async () => {
    expect(await page.textContent('.unsafe-fs-fetch-raw-query1')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-raw-query1-status')).toBe(
      '403',
    )
  })

  test('unsafe fs fetch query 2', async () => {
    expect(await page.textContent('.unsafe-fs-fetch-raw-query2')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-raw-query2-status')).toBe(
      '403',
    )
  })

  test('unsafe fs fetch with special characters (#8498)', async () => {
    expect(await page.textContent('.unsafe-fs-fetch-8498')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-8498-status')).toBe('404')
  })

  test('unsafe fs fetch with special characters 2 (#8498)', async () => {
    expect(await page.textContent('.unsafe-fs-fetch-8498-2')).toBe('')
    expect(await page.textContent('.unsafe-fs-fetch-8498-2-status')).toBe('404')
  })

  test('unsafe fs fetch import inline', async () => {
    expect(
      await page.textContent('.unsafe-fs-fetch-import-inline-status'),
    ).toBe('403')
  })

  test('unsafe fs fetch import inline wasm init', async () => {
    expect(
      await page.textContent('.unsafe-fs-fetch-import-inline-wasm-init-status'),
    ).toBe('403')
  })

  test('nested entry', async () => {
    expect(await page.textContent('.nested-entry')).toBe('foobar')
  })

  test('denied', async () => {
    expect(await page.textContent('.unsafe-dotenv')).toBe('403')
  })

  test('denied EnV casing', async () => {
    // It is 403 in case insensitive system, 404 in others
    const code = await page.textContent('.unsafe-dotEnV-casing')
    expect(code === '403' || code === '404').toBeTruthy()
  })

  test('denied .env with NTFS ADS suffix', async () => {
    // It is 403 on NTFS, 404 on others
    await expect
      .poll(() => page.textContent('.unsafe-dotenv-ntfs-ads'))
      .toMatch(/^(?:403|404)$/)
  })

  const dotEnvWindows83ShortName = getWindows83ShortNameForDotEnv()
  test.skipIf(dotEnvWindows83ShortName === undefined)(
    'denied .env with 8.3 short name',
    async () => {
      await expect
        .poll(() => page.textContent('.unsafe-dotenv-83-short-name'))
        .toBe('403')
    },
  )
})

describe('fetch', () => {
  test('serve with configured headers', async () => {
    const res = await fetch(viteTestUrl + '/src/')
    expect(res.headers.get('x-served-by')).toBe('vite')
  })
})

describe.runIf(isServe)('invalid request', () => {
  const sendRawRequest = async (baseUrl: string, requestTarget: string) => {
    return new Promise<string>((resolve, reject) => {
      const parsedUrl = new URL(baseUrl)

      const buf: Buffer[] = []
      const client = net.createConnection(
        { port: +parsedUrl.port, host: parsedUrl.hostname },
        () => {
          client.write(
            [
              `GET ${encodeURI(requestTarget)} HTTP/1.1`,
              `Host: ${parsedUrl.host}`,
              'Connection: Close',
              '\r\n',
            ].join('\r\n'),
          )
        },
      )
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

  const root = path
    .resolve(__dirname.replace('playground', 'playground-temp'), '..')
    .replace(/\\/g, '/')

  test('should not allow relative path traversal with optimize deps sourcemap handler', async () => {
    const response = await sendRawRequest(
      viteTestUrl,
      path.posix.join('/@fs/', root) +
        '/node_modules/.vite/deps/../../../unsafe.map',
    )
    expect(response).toContain('HTTP/1.1 403 Forbidden')
  })

  test('should not allow backslash relative path traversal with optimize deps sourcemap handler', async () => {
    const response = await sendRawRequest(
      viteTestUrl,
      path.posix.join('/@fs/', root) +
        '/node_modules/.vite/deps/..\\..\\..\\unsafe.map',
    )
    if (isWindows) {
      expect(response).toContain('HTTP/1.1 403 Forbidden')
    } else {
      // should be 404 fallback
      expect(response).toContain('Cache-Control: no-cache')
    }
  })
})
