import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_FILENAME_REGEX,
  STORY_ID_REGEX,
  type AllowedImageMime,
} from '@/lib/types/story';

export { ASSET_FILENAME_REGEX, STORY_ID_REGEX, type AllowedImageMime };

const ENCODED_TRAVERSAL_REGEX = /%(?:25)*(2e|2f|5c|00)/i;
const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:/;

const POLISH_TRANSLITERATION: Record<string, string> = {
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z',
  Ą: 'a',
  Ć: 'c',
  Ę: 'e',
  Ł: 'l',
  Ń: 'n',
  Ó: 'o',
  Ś: 's',
  Ź: 'z',
  Ż: 'z',
};

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export class PathSecurityError extends Error {
  public readonly httpStatus = 400;
  public readonly code: string;

  constructor(message: string, code = 'PATH_SECURITY_VIOLATION') {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
  }
}

export function assertValidStoryId(id: string): string {
  if (typeof id !== 'string' || id.includes('\0') || !STORY_ID_REGEX.test(id)) {
    throw new PathSecurityError('Invalid story ID', 'INVALID_STORY_ID');
  }
  return id;
}

export function assertValidAssetFilename(filename: string): string {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > 70 ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.includes('%') ||
    !ASSET_FILENAME_REGEX.test(filename) ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename
  ) {
    throw new PathSecurityError('Invalid asset filename', 'INVALID_ASSET_FILENAME');
  }
  return filename;
}

export function resolveSafeChildPath(baseDir: string, ...segments: string[]): string {
  if (typeof baseDir !== 'string' || baseDir.length === 0 || baseDir.includes('\0')) {
    throw new PathSecurityError('Invalid base directory', 'INVALID_BASE_DIR');
  }
  if (segments.length === 0) {
    throw new PathSecurityError('Child path requires at least one segment', 'EMPTY_PATH_SEGMENTS');
  }

  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.includes('\0')) {
      throw new PathSecurityError('Invalid path segment', 'INVALID_PATH_SEGMENT');
    }
    if (seg.includes('\\')) {
      throw new PathSecurityError('Backslashes are not allowed in path segments', 'PATH_TRAVERSAL');
    }
    if (path.isAbsolute(seg) || WINDOWS_DRIVE_REGEX.test(seg)) {
      throw new PathSecurityError('Absolute path segments are not allowed', 'PATH_TRAVERSAL');
    }
    if (ENCODED_TRAVERSAL_REGEX.test(seg)) {
      throw new PathSecurityError(
        'URL-encoded traversal sequences are not allowed',
        'PATH_TRAVERSAL',
      );
    }

    const parts = seg.split('/');
    for (const part of parts) {
      if (part === '' || part === '.' || part === '..') {
        throw new PathSecurityError('Path traversal segment detected', 'PATH_TRAVERSAL');
      }
    }
  }

  const resolvedBase = path.resolve(baseDir);
  const basePrefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : `${resolvedBase}${path.sep}`;
  const resolvedTarget = path.resolve(resolvedBase, ...segments);

  if (resolvedTarget === resolvedBase || !resolvedTarget.startsWith(basePrefix)) {
    throw new PathSecurityError('Resolved path escapes base directory', 'PATH_TRAVERSAL');
  }

  if (fs.existsSync(resolvedBase)) {
    let realBase: string;
    try {
      realBase = fs.realpathSync(resolvedBase);
    } catch {
      throw new PathSecurityError('Unable to resolve storage root safely', 'SYMLINK_ESCAPE');
    }
    const realBasePrefix = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;

    let cursor = resolvedTarget;
    const trailing: string[] = [];

    while (cursor !== resolvedBase) {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(cursor);
      } catch (err) {
        const code = getErrnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          stat = null;
        } else if (code === 'ELOOP') {
          throw new PathSecurityError(
            'Symlink loop detected inside storage root',
            'SYMLINK_ESCAPE',
          );
        } else {
          throw new PathSecurityError('Unable to inspect path safely', 'SYMLINK_ESCAPE');
        }
      }

      if (stat) {
        if (stat.isSymbolicLink()) {
          let realCursor: string;
          try {
            realCursor = fs.realpathSync(cursor);
          } catch {
            throw new PathSecurityError(
              'Dangling or cyclic symlink is not allowed inside storage root',
              'SYMLINK_ESCAPE',
            );
          }
          const realTarget =
            trailing.length > 0 ? path.resolve(realCursor, ...trailing) : realCursor;
          if (realTarget === realBase || !realTarget.startsWith(realBasePrefix)) {
            throw new PathSecurityError('Symlink escapes storage root', 'SYMLINK_ESCAPE');
          }
          break;
        }

        let realCursor: string;
        try {
          realCursor = fs.realpathSync(cursor);
        } catch {
          throw new PathSecurityError(
            'Path cannot be safely resolved inside storage root',
            'SYMLINK_ESCAPE',
          );
        }
        const realTarget =
          trailing.length > 0 ? path.resolve(realCursor, ...trailing) : realCursor;
        if (realTarget === realBase || !realTarget.startsWith(realBasePrefix)) {
          throw new PathSecurityError('Path resolves outside storage root', 'SYMLINK_ESCAPE');
        }
        break;
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      trailing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  return resolvedTarget;
}

export function detectImageMime(buffer: Buffer): AllowedImageMime | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export function extensionForMime(mime: AllowedImageMime): 'jpg' | 'png' | 'webp' {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}

export function sanitizeFileSlug(
  input: string,
  fallback = 'bajka',
  maxLength = 48,
): string {
  const safeMax = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 48;
  const transliterated = Array.from(typeof input === 'string' ? input : '')
    .map((ch) => POLISH_TRANSLITERATION[ch] ?? ch)
    .join('');

  const slug = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, safeMax)
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : fallback;
}
