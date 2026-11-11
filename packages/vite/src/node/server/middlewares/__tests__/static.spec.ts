import path from 'node:path'
import picomatch from 'picomatch'
import { describe, expect, test } from 'vitest'
import type { ViteDevServer } from '../../index'
import { isWindows } from '../../../../shared/utils'
import {
  isFileLoadingAllowed,
  isFileServingAllowed,
  isUriInFilePath,
  looksLikeWindowsShortNamePath,
} from '../static'

describe('isUriInFilePath', () => {
  const cases = {
    '/parent': {
      '/parent': true,
      '/parenta': false,
      '/parent/': true,
      '/parent/child': true,
      '/parent/child/child2': true,
    },
    '/parent/': {
      '/parent': false,
      '/parenta': false,
      '/parent/': true,
      '/parent/child': true,
      '/parent/child/child2': true,
    },
  }

  for (const [parent, children] of Object.entries(cases)) {
    for (const [child, expected] of Object.entries(children)) {
      test(`isUriInFilePath("${parent}", "${child}")`, () => {
        expect(isUriInFilePath(parent, child)).toBe(expected)
      })
    }
  }
})

describe('looksLikeWindowsShortNamePath', () => {
  const shortNamePaths = [
    // classic 8.3 short names
    'C:/PROGRA~1/x',
    'C:/PROGRA~1',
    'C:/LONGFI~1.TXT',
    'C:/MICROS~2/foo',
    // short-name-looking directory ancestor, not just the basename
    'C:/foo/DOCUME~1/bar.js',
  ]
  const legitimateTildePaths = [
    // real-world case from the reported issue: `~` not followed by a digit
    'C:/project/dist/0~rslib-runtime.js',
    // ancestor directory containing a tilde that isn't short-name shaped
    'C:/Users/foo~bar/project/index.js',
    // tilde-prefixed name with no short-name-style prefix/digit suffix
    'C:/Users/foo/~backup/index.js',
    // prefix longer than the 6 characters a short name can have
    'C:/project/confirmations~2/index.js',
    // no tilde at all
    'C:/Users/foo/project/index.js',
  ]

  for (const filePath of shortNamePaths) {
    test(`looksLikeWindowsShortNamePath("${filePath}") is true`, () => {
      expect(looksLikeWindowsShortNamePath(filePath)).toBe(true)
    })
  }
  for (const filePath of legitimateTildePaths) {
    test(`looksLikeWindowsShortNamePath("${filePath}") is false`, () => {
      expect(looksLikeWindowsShortNamePath(filePath)).toBe(false)
    })
  }
})

// mirrors the default `server.fs.deny` matching: the basename for `.env*`,
// any path segment for `.git`
function isDeniedByFsDenyGlob(filePath: string): boolean {
  if (filePath.split('/').includes('.git')) return true
  const basename = path.posix.basename(filePath)
  return basename === '.env' || basename === '.env.local'
}

function createStubServer(allowedDir: string): ViteDevServer {
  const server = {
    config: {
      server: {
        fs: {
          strict: true,
          allow: [allowedDir],
          deny: ['.env', '.env.*', '**/.git/**'],
        },
      },
    },
    _fsDenyGlob: isDeniedByFsDenyGlob,
    moduleGraph: {
      safeModulesPath: new Set<string>(),
    },
  }
  return server as unknown as ViteDevServer
}

describe('isFileServingAllowed', () => {
  const root = isWindows ? 'C:/allowed' : '/allowed'
  const server = createStubServer(root)
  const isAllowed = (p: string) => isFileServingAllowed(p, server)

  test('allows a file inside fs.allow', () => {
    expect(isAllowed(`${root}/src/main.js`)).toBe(true)
  })

  test('denies a file matching fs.deny', () => {
    expect(isAllowed(`${root}/.env`)).toBe(false)
    expect(isAllowed(`${root}/.git/config`)).toBe(false)
  })

  test('denies a file outside of fs.allow', () => {
    const outside = isWindows ? 'C:/other/a.txt' : '/other/a.txt'
    expect(isAllowed(outside)).toBe(false)
  })

  test('allows a file name that merely contains a tilde', () => {
    expect(isAllowed(`${root}/dist/0~rslib-runtime.js`)).toBe(true)
    expect(isAllowed(`${root}/foo~bar/index.js`)).toBe(true)
  })

  // On NTFS, `.env::$DATA` is the default data stream of `.env` and
  // resolves to the same content, while slipping past `server.fs.deny`
  test('denies a path with an NTFS ADS suffix', () => {
    expect(isAllowed(`${root}/.env::$DATA`)).toBe(false)
    expect(isAllowed(`${root}/.env:stream`)).toBe(false)
    expect(isAllowed(`${root}/.git::$INDEX_ALLOCATION/config`)).toBe(false)
  })

  test('denies a `/@fs/` url with an NTFS ADS suffix', () => {
    const fsRoot = root.replace(/^\//, '')
    expect(isAllowed(`/@fs/${fsRoot}/.env::$DATA`)).toBe(false)
  })

  // On Windows, the files can be accessed through the 8.3 short name if
  // the feature is enabled. For example, `.env` can be accessed as `ENV~1`
  test.runIf(isWindows)('denies a path with an 8.3 short name', () => {
    expect(isAllowed(`${root}/ENV~1`)).toBe(false)
    expect(isAllowed(`${root}/env~1`)).toBe(false)
    expect(isAllowed(`${root}/GIT~1/config`)).toBe(false)
  })

  test.runIf(isWindows)('allows a lowercase drive letter', () => {
    const lowercaseServer = createStubServer('c:/allowed')
    const filePath = 'c:/allowed/src/main.js'
    expect(isFileServingAllowed(filePath, lowercaseServer)).toBe(true)
  })
})

// `isFileLoadingAllowed` receives the resolved file path (e.g. from sirv's
// `shouldServe`), so it must apply the same checks as `isFileServingAllowed`
describe('isFileLoadingAllowed', () => {
  const root = isWindows ? 'C:/allowed' : '/allowed'
  const server = createStubServer(root)
  const isAllowed = (p: string) => isFileLoadingAllowed(server, p)

  test('allows a file inside fs.allow', () => {
    expect(isAllowed(`${root}/src/main.js`)).toBe(true)
  })

  test('denies a file matching fs.deny', () => {
    expect(isAllowed(`${root}/.env`)).toBe(false)
    expect(isAllowed(`${root}/.git/config`)).toBe(false)
  })

  test('denies a file outside of fs.allow', () => {
    const outside = isWindows ? 'C:/other/a.txt' : '/other/a.txt'
    expect(isAllowed(outside)).toBe(false)
  })

  test('denies a path with an NTFS ADS suffix', () => {
    expect(isAllowed(`${root}/.env::$DATA`)).toBe(false)
    expect(isAllowed(`${root}/.env:stream`)).toBe(false)
  })

  test.runIf(isWindows)('denies a path with an 8.3 short name', () => {
    expect(isAllowed(`${root}/ENV~1`)).toBe(false)
    expect(isAllowed(`${root}/GIT~1/config`)).toBe(false)
  })

  // `fs.readFile('/foo/.env/')` reads `/foo/.env`, and on Windows a request
  // ending with `\` is normalized to a path ending with `/`
  test('denies a denied file with a trailing slash', () => {
    const denyGlobServer = {
      ...server,
      // same matcher options as the dev server's `_fsDenyGlob`
      _fsDenyGlob: picomatch(['**/.env', '**/.env.*', '**/*.{crt,pem}'], {
        matchBase: false,
        nocase: true,
        dot: true,
      }),
    } as unknown as ViteDevServer
    const isAllowedByGlob = (p: string) =>
      isFileLoadingAllowed(denyGlobServer, p)
    expect(isAllowedByGlob(`${root}/src/main.js`)).toBe(true)
    expect(isAllowedByGlob(`${root}/.env`)).toBe(false)
    expect(isAllowedByGlob(`${root}/.env/`)).toBe(false)
    expect(isAllowedByGlob(`${root}/src/dummy.crt/`)).toBe(false)
  })
})
