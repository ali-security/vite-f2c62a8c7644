import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import type { ViteDevServer } from '../index'
import { createServer } from '../index'
import { isWindows } from '../../../shared/utils'

type OnError = (fileName: string, errorMessage: string | null) => void
type LaunchEditor = (file: string, editor?: string, onError?: OnError) => void
type Middleware = (req: { url: string }, res: { end: () => void }) => void

const _require = createRequire(import.meta.url)

// vite bundles launch-editor-middleware and its launch-editor dependency.
// Resolve launch-editor the same way the middleware does, so that the copy
// patched through `pnpm.patchedDependencies` is the one under test.
const middlewarePath = _require.resolve('launch-editor-middleware')
const launchEditorPath = _require.resolve('launch-editor', {
  paths: [path.dirname(middlewarePath)],
})
const createMiddleware: () => Middleware = _require(middlewarePath)
const launchEditor: LaunchEditor = _require(launchEditorPath)

// launch-editor looks these functions up on the shared module objects when it
// is called, so stubbing them intercepts the editor process it would launch
const childProcess = _require('node:child_process')
const nodeFs = _require('node:fs')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  })
}

// test files share the process (`isolate: false`), so always restore it
function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform)
}

const EXEC_OPTIONS = { stdio: 'inherit', shell: true }
const SPAWN_OPTIONS = { stdio: 'inherit' }
const CMD_METACHARS = ['&', '|', '<', '>', ',', ';', '=', '^']
const FILE_ROOT = isWindows ? 'C:\\project\\' : '/project/'

// file-system routing conventions of meta frameworks
const ROUTE_FILE_NAMES = [
  '+page.svelte',
  '$route.tsx',
  '(group)\\page.tsx',
  '@route\\page.tsx',
  '[slug]\\page.tsx',
]

// CMD.exe expands `%VAR%` before consuming `^` escapes and treats line
// breaks as command separators, so these cannot be escaped
const REJECTED_FILE_NAMES = [
  'C:\\project\\%PATH%.js',
  'C:\\project\\%VAR:old=new%.js',
  'C:\\project\\file.js\ncalc.exe',
  'C:\\project\\file.js\r\ncalc.exe',
  'C:\\project\\file.js\r&calc.exe',
]

function createFakeChildProcess() {
  return Object.assign(new EventEmitter(), { kill: vi.fn() })
}

/**
 * Whether `command` contains a metacharacter that is not escaped with `^`,
 * i.e. one that CMD.exe would interpret instead of passing it to the editor.
 */
function hasUnescapedCmdMetachar(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '^') {
      i++
    } else if (CMD_METACHARS.includes(command[i])) {
      return true
    }
  }
  return false
}

describe('launch-editor (CVE-2024-52011)', () => {
  let exec = vi.fn(createFakeChildProcess)
  let spawn = vi.fn(createFakeChildProcess)
  let onError = vi.fn()

  beforeEach(() => {
    exec = vi.fn(createFakeChildProcess)
    spawn = vi.fn(createFakeChildProcess)
    onError = vi.fn()
    setPlatform('win32')
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)
    vi.spyOn(childProcess, 'spawn').mockImplementation(spawn)
    vi.spyOn(nodeFs, 'existsSync').mockReturnValue(true)
    // launch-editor logs the files it could not open
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    restorePlatform()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function expectLaunchCommand(command: string) {
    expect(spawn).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(command, EXEC_OPTIONS)
    expect(hasUnescapedCmdMetachar(command)).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  }

  describe('on Windows', () => {
    test('launches the editor through the shell', () => {
      launchEditor('C:\\project\\src\\main.ts', 'code', onError)
      expectLaunchCommand('code C:\\project\\src\\main.ts')
    })

    test('passes the line and column numbers', () => {
      launchEditor('C:\\project\\src\\main.ts:10:5', 'code', onError)
      expectLaunchCommand('code -r -g C:\\project\\src\\main.ts:10:5')
    })

    test('quotes file names containing spaces', () => {
      launchEditor('C:\\my project\\src\\main.ts', 'code', onError)
      expectLaunchCommand('code "C:\\my project\\src\\main.ts"')
    })

    test('quotes an editor path containing spaces', () => {
      const editor = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
      vi.stubEnv('LAUNCH_EDITOR', editor)
      launchEditor('C:\\project\\src\\main.ts', undefined, onError)
      expectLaunchCommand(`"${editor}" C:\\project\\src\\main.ts`)
    })

    // https://github.com/vitejs/launch-editor/security/advisories/GHSA-c27g-q93r-2cwf
    test('escapes the command injection from the advisory', () => {
      const file = 'C:\\Users\\myusername\\Downloads\\& curl 172.21.93.52'
      launchEditor(file, 'code', onError)
      expectLaunchCommand(
        'code ^"C:\\Users\\myusername\\Downloads\\^& curl 172.21.93.52^"',
      )
    })

    test.each(CMD_METACHARS)('escapes %s in file names', (char) => {
      launchEditor(`C:\\project\\a${char}calc.exe`, 'code', onError)
      expectLaunchCommand(`code ^"C:\\project\\a^${char}calc.exe^"`)
    })

    test('escapes all CMD metacharacters at once', () => {
      launchEditor('C:\\project\\&|<>,;=^file.js', 'code', onError)
      expectLaunchCommand('code ^"C:\\project\\^&^|^<^>^,^;^=^^file.js^"')
    })

    test('escapes CMD metacharacters next to the line number', () => {
      launchEditor('C:\\project\\&calc.exe.js:10:5', 'code', onError)
      expectLaunchCommand('code -r -g ^"C:\\project\\^&calc.exe.js:10:5^"')
    })

    test.each(ROUTE_FILE_NAMES)('opens route files like %s', (route) => {
      const file = `C:\\project\\src\\routes\\${route}`
      launchEditor(file, 'code', onError)
      expectLaunchCommand(`code ${file}`)
    })

    test.each(REJECTED_FILE_NAMES)('rejects %j', (file) => {
      launchEditor(file, 'code', onError)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(
        file,
        expect.stringContaining('"%" or line breaks'),
      )
    })

    test('escapes CMD metacharacters in /__open-in-editor requests', () => {
      vi.stubEnv('LAUNCH_EDITOR', 'code')
      const file = `${FILE_ROOT}a&calc.exe.js`
      const res = { end: vi.fn() }
      createMiddleware()({ url: `/?file=${encodeURIComponent(file)}` }, res)
      expect(res.end).toHaveBeenCalledTimes(1)
      expectLaunchCommand(`code ^"${FILE_ROOT}a^&calc.exe.js^"`)
    })

    test('rejects "%" in /__open-in-editor requests', () => {
      vi.stubEnv('LAUNCH_EDITOR', 'code')
      const file = `${FILE_ROOT}%PATH%.js`
      const res = { end: vi.fn() }
      createMiddleware()({ url: `/?file=${encodeURIComponent(file)}` }, res)
      expect(res.end).toHaveBeenCalledTimes(1)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  describe('on other platforms', () => {
    beforeEach(() => {
      setPlatform('linux')
    })

    test('spawns the editor without a shell', () => {
      const file = '/project/a&calc.exe%PATH%.js'
      launchEditor(file, 'code', onError)
      expect(exec).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith('code', [file], SPAWN_OPTIONS)
      expect(onError).not.toHaveBeenCalled()
    })
  })
})

describe.runIf(isWindows)('/__open-in-editor on Windows', () => {
  let tmpDir: string
  let server: ViteDevServer | undefined
  let httpServer: http.Server | undefined
  let port: number

  const sendRequest = (requestPath: string) => {
    return new Promise<number | undefined>((resolve, reject) => {
      const url = `http://127.0.0.1:${port}${requestPath}`
      const req = http.get(url, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
    })
  }

  beforeAll(async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vite-launch-editor-')),
    )
    fs.writeFileSync(path.join(tmpDir, 'a&calc.exe.js'), '')
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

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('escapes CMD metacharacters in the requested file name', async () => {
    vi.stubEnv('LAUNCH_EDITOR', 'code')
    const exec = vi.fn(createFakeChildProcess)
    vi.spyOn(childProcess, 'exec').mockImplementation(exec)

    const file = path.join(tmpDir, 'a&calc.exe.js')
    const query = `file=${encodeURIComponent(file)}`
    const statusCode = await sendRequest(`/__open-in-editor?${query}`)
    expect(statusCode).toBe(200)

    const command = `code ^"${path.join(tmpDir, 'a^&calc.exe.js')}^"`
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(command, EXEC_OPTIONS)
    expect(hasUnescapedCmdMetachar(command)).toBe(false)
  })
})
