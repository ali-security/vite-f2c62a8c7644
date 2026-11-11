import path from 'node:path'
import { parse as parseUrl } from 'node:url'
import type { Connect } from 'dep-types/connect'
import { isWindows } from '../../../shared/utils'

// launch-editor strips a trailing `:line` or `:line:column` from the file name
const positionRE = /:\d+(?::\d+)?$/

/**
 * Whether the file requested to be opened in the editor is a Windows UNC path
 * (e.g. `\\server\share\file.js` or `//server/share/file.js`).
 *
 * launch-editor checks whether the requested file exists, and accessing a UNC
 * path makes Windows connect to the remote server over SMB, which leaks the
 * NTLM credentials of the user running the dev server.
 */
export function isWindowsUNCPath(file: string): boolean {
  // resolve the file name the same way as launch-editor-middleware and
  // launch-editor do before accessing it
  const fileName = path.win32.resolve(file).replace(positionRE, '')
  return path.win32.resolve(fileName).startsWith('\\\\')
}

export function openInEditorGuardMiddleware(): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteOpenInEditorGuardMiddleware(req, res, next) {
    if (isWindows) {
      // parse the query the same way as launch-editor-middleware
      const { file } = parseUrl(req.url!, true).query
      const files = typeof file === 'string' ? [file] : file
      if (files?.some((f) => isWindowsUNCPath(f))) {
        res.statusCode = 403
        res.end(
          'UNC paths are not supported on Windows to avoid security issues.',
        )
        return
      }
    }
    next()
  }
}
