import { app, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { FileBrowserRequest, FileDefaultAppDTO } from '../shared/types'
import { resolveFilePath } from './file-path'

const execute = promisify(execFile)
const iconCache = new Map<string, { expires: number; value: Promise<string | null> }>()
const ICON_CACHE_LIMIT = 64
const ICON_CACHE_MS = 60_000

/** Load the bundle's artwork directly. NSWorkspace's display icon can include
 * an additional system tile around the app's own icon on newer macOS versions.
 * AppKit decodes original ICNS/PNG and asset-catalog resources without that
 * composition, including older ICNS encodings Electron cannot decode itself.
 * This only reads bundle resources; it never loads the application's code. */
const ORIGINAL_ICON_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var bundle = $.NSBundle.bundleWithPath(argv[0]);
  var iconFile = ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleIconFile'));
  var iconName = iconFile || ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleIconName'));
  if (!iconName) return '';
  var resource = bundle.pathForImageResource(iconName);
  var original = ObjC.unwrap(resource) ? $.NSImage.alloc.initWithContentsOfFile(resource) : bundle.imageForResource(iconName);
  if (!original || !original.valid) return '';
  var size = original.size;
  if (size.width <= 0 || size.height <= 0) return '';
  var scale = Math.min(32 / size.width, 32 / size.height);
  var width = size.width * scale, height = size.height * scale;
  var image = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
  image.lockFocus;
  original.drawInRectFromRectOperationFraction($.NSMakeRect((32 - width) / 2, (32 - height) / 2, width, height), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  image.unlockFocus;
  var bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  var data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`

async function readOriginalIcon(applicationPath: string): Promise<string | null> {
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ORIGINAL_ICON_SCRIPT, applicationPath], {
      timeout: 3_000, maxBuffer: 128 * 1024
    })
    const bytes = Buffer.from(stdout.trim(), 'base64')
    const image = nativeImage.createFromBuffer(bytes)
    const { width, height } = image.getSize()
    if (image.isEmpty() || width > 128 || height > 128) return null
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch { return null }
}

function originalIcon(applicationPath: string): Promise<string | null> {
  const cached = iconCache.get(applicationPath)
  if (cached && cached.expires > Date.now()) return cached.value
  const value = readOriginalIcon(applicationPath)
  iconCache.delete(applicationPath)
  iconCache.set(applicationPath, { expires: Date.now() + ICON_CACHE_MS, value })
  while (iconCache.size > ICON_CACHE_LIMIT) iconCache.delete(iconCache.keys().next().value!)
  return value
}

/** On macOS Electron queries Launch Services for the complete file URL to
 * identify the associated application. Other platforms resolve only
 * the URL scheme, which would identify a file manager instead of this file's
 * default application; keep the toolbar fallback there. */
export async function fileDefaultApp(request: FileBrowserRequest): Promise<FileDefaultAppDTO | null> {
  try {
    if (process.platform !== 'darwin') return null
    const path = resolveFilePath(request)
    const application = await app.getApplicationInfoForProtocol(pathToFileURL(path).href)
    const icon = await originalIcon(application.path)
    if (!icon) return null
    return {
      name: application.name,
      icon
    }
  } catch { return null }
}
