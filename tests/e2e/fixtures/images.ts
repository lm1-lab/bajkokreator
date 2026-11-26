import sharp from 'sharp';

export interface E2EFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export type ChildPhotoVariant = 1 | 2 | 3 | 4;

interface PortraitPalette {
  bgTop: string;
  bgBottom: string;
  halo: string;
  shirt: string;
  hair: string;
  skin: string;
  cheek: string;
  accent: string;
}

const PORTRAIT_PALETTES: Record<ChildPhotoVariant, PortraitPalette> = {
  1: {
    bgTop: '#F9E8D2',
    bgBottom: '#E6C29F',
    halo: '#FFF8EB',
    shirt: '#9F4A2C',
    hair: '#5A3A22',
    skin: '#F3C7A6',
    cheek: '#E28E7B',
    accent: '#C49A45',
  },
  2: {
    bgTop: '#DCEAE2',
    bgBottom: '#A8C7B7',
    halo: '#F4FBF6',
    shirt: '#4E6B58',
    hair: '#2E2520',
    skin: '#EFC09B',
    cheek: '#DF8B77',
    accent: '#D97B48',
  },
  3: {
    bgTop: '#E4E7F5',
    bgBottom: '#BCC6E3',
    halo: '#F7F8FD',
    shirt: '#4A5D8F',
    hair: '#C78A3B',
    skin: '#F7D2B5',
    cheek: '#E79A8B',
    accent: '#E0B44C',
  },
  4: {
    bgTop: '#F7E1E6',
    bgBottom: '#DFB6C1',
    halo: '#FDF5F7',
    shirt: '#8E4860',
    hair: '#4B2E1E',
    skin: '#E9B791',
    cheek: '#D87E72',
    accent: '#5A8472',
  },
};

function assertJpegMagic(buffer: Buffer, label: string): void {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8 ||
    buffer[2] !== 0xff
  ) {
    throw new Error(`Invalid JPEG magic bytes generated for ${label}`);
  }
}

function assertPngMagic(buffer: Buffer, label: string): void {
  if (
    buffer.length < 8 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d ||
    buffer[5] !== 0x0a ||
    buffer[6] !== 0x1a ||
    buffer[7] !== 0x0a
  ) {
    throw new Error(`Invalid PNG magic bytes generated for ${label}`);
  }
}

function assertWebpMagic(buffer: Buffer, label: string): void {
  const riff = buffer.subarray(0, 4).toString('ascii');
  const webp = buffer.subarray(8, 12).toString('ascii');
  if (buffer.length < 12 || riff !== 'RIFF' || webp !== 'WEBP') {
    throw new Error(`Invalid WebP magic bytes generated for ${label}`);
  }
}

function buildPortraitSvg(
  width: number,
  height: number,
  palette: PortraitPalette,
  seed: number,
): string {
  const cx = Math.round(width / 2);
  const cy = Math.round(height * 0.44);
  const faceRadius = Math.round(Math.min(width, height) * 0.21);
  const shoulderY = Math.round(height * 0.78);
  const starOffset = seed * 19;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="${palette.bgTop}"/>
      <stop offset="100%" stop-color="${palette.bgBottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="45%">
      <stop offset="0%" stop-color="${palette.halo}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${palette.halo}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="${Math.round(Math.min(width, height) * 0.42)}" fill="url(#glow)"/>
  <circle cx="${Math.round(width * 0.16) + starOffset}" cy="${Math.round(height * 0.18)}" r="26" fill="${palette.accent}" opacity="0.28"/>
  <circle cx="${Math.round(width * 0.82) - starOffset}" cy="${Math.round(height * 0.24)}" r="18" fill="${palette.accent}" opacity="0.35"/>
  <path d="M ${cx - Math.round(width * 0.34)} ${height} Q ${cx} ${shoulderY - 90} ${cx + Math.round(width * 0.34)} ${height} Z" fill="${palette.shirt}"/>
  <circle cx="${cx}" cy="${cy - Math.round(faceRadius * 0.12)}" r="${Math.round(faceRadius * 1.15)}" fill="${palette.hair}"/>
  <circle cx="${cx}" cy="${cy}" r="${faceRadius}" fill="${palette.skin}"/>
  <path d="M ${cx - faceRadius} ${cy - Math.round(faceRadius * 0.2)} Q ${cx} ${cy - Math.round(faceRadius * 1.25)} ${cx + faceRadius} ${cy - Math.round(faceRadius * 0.2)} Q ${cx} ${cy - Math.round(faceRadius * 0.55)} ${cx - faceRadius} ${cy - Math.round(faceRadius * 0.2)} Z" fill="${palette.hair}"/>
  <circle cx="${cx - Math.round(faceRadius * 0.36)}" cy="${cy - Math.round(faceRadius * 0.05)}" r="${Math.round(faceRadius * 0.09)}" fill="#261E18"/>
  <circle cx="${cx + Math.round(faceRadius * 0.36)}" cy="${cy - Math.round(faceRadius * 0.05)}" r="${Math.round(faceRadius * 0.09)}" fill="#261E18"/>
  <circle cx="${cx - Math.round(faceRadius * 0.33)}" cy="${cy - Math.round(faceRadius * 0.08)}" r="${Math.round(faceRadius * 0.03)}" fill="#FFFFFF"/>
  <circle cx="${cx + Math.round(faceRadius * 0.39)}" cy="${cy - Math.round(faceRadius * 0.08)}" r="${Math.round(faceRadius * 0.03)}" fill="#FFFFFF"/>
  <ellipse cx="${cx - Math.round(faceRadius * 0.48)}" cy="${cy + Math.round(faceRadius * 0.18)}" rx="${Math.round(faceRadius * 0.16)}" ry="${Math.round(faceRadius * 0.1)}" fill="${palette.cheek}" opacity="0.55"/>
  <ellipse cx="${cx + Math.round(faceRadius * 0.48)}" cy="${cy + Math.round(faceRadius * 0.18)}" rx="${Math.round(faceRadius * 0.16)}" ry="${Math.round(faceRadius * 0.1)}" fill="${palette.cheek}" opacity="0.55"/>
  <path d="M ${cx - Math.round(faceRadius * 0.28)} ${cy + Math.round(faceRadius * 0.32)} Q ${cx} ${cy + Math.round(faceRadius * 0.54)} ${cx + Math.round(faceRadius * 0.28)} ${cy + Math.round(faceRadius * 0.32)}" fill="none" stroke="#6E3B2A" stroke-width="${Math.max(5, Math.round(faceRadius * 0.06))}" stroke-linecap="round"/>
</svg>`;
}

function buildStorybookSceneSvg(variant: 'page' | 'cover' | 'webp'): string {
  const skyTop =
    variant === 'cover' ? '#24344D' : variant === 'webp' ? '#E9D6B5' : '#C9DFD4';
  const skyBottom =
    variant === 'cover' ? '#587496' : variant === 'webp' ? '#C78E5D' : '#F4E5C8';
  const hillFar =
    variant === 'cover' ? '#364F4A' : variant === 'webp' ? '#7D6A4E' : '#6A8B74';
  const hillNear =
    variant === 'cover' ? '#263A34' : variant === 'webp' ? '#4F5A45' : '#4E6B58';
  const sunColor =
    variant === 'cover' ? '#F8E39A' : variant === 'webp' ? '#FFF1C1' : '#F7C96E';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${skyTop}"/>
      <stop offset="100%" stop-color="${skyBottom}"/>
    </linearGradient>
    <radialGradient id="sun" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${sunColor}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${sunColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="640" height="640" fill="url(#sky)"/>
  <circle cx="470" cy="150" r="110" fill="url(#sun)"/>
  <circle cx="470" cy="150" r="46" fill="${sunColor}"/>
  <path d="M 0 430 Q 180 310 380 390 T 640 360 L 640 640 L 0 640 Z" fill="${hillFar}"/>
  <path d="M 0 490 Q 210 410 420 475 T 640 445 L 640 640 L 0 640 Z" fill="${hillNear}"/>
  <rect x="210" y="370" width="130" height="105" rx="6" fill="#F4E6CF"/>
  <polygon points="195,375 275,305 355,375" fill="#9F4A2C"/>
  <rect x="255" y="415" width="38" height="60" rx="18" fill="#6E4229"/>
  <circle cx="232" cy="402" r="14" fill="#F6D06F"/>
  <circle cx="316" cy="402" r="14" fill="#F6D06F"/>
  <path d="M 274 475 C 280 530 220 580 155 640 L 235 640 C 280 590 318 535 292 475 Z" fill="#DFC59B"/>
  <circle cx="115" cy="435" r="44" fill="#3B5B45"/>
  <rect x="108" y="468" width="14" height="58" fill="#5D3E2B"/>
  <circle cx="525" cy="415" r="52" fill="#365341"/>
  <rect x="517" y="458" width="16" height="65" fill="#5D3E2B"/>
</svg>`;
}

const childPhotoCache = new Map<ChildPhotoVariant, Promise<Buffer>>();
let highResPhotoCache: Promise<Buffer> | null = null;
const customPngCache = new Map<'page' | 'cover', Promise<Buffer>>();
let customWebpCache: Promise<Buffer> | null = null;

async function generateChildPhotoBuffer(
  variant: ChildPhotoVariant,
): Promise<Buffer> {
  const svg = buildPortraitSvg(640, 640, PORTRAIT_PALETTES[variant], variant);
  const buffer = await sharp(Buffer.from(svg))
    .toColorspace('srgb')
    .jpeg({ quality: 90, progressive: false })
    .toBuffer();
  assertJpegMagic(buffer, `child-photo-${variant}.jpg`);
  return buffer;
}

export async function getChildPhotoFixture(
  variant: ChildPhotoVariant = 1,
): Promise<E2EFilePayload> {
  let pending = childPhotoCache.get(variant);
  if (!pending) {
    pending = generateChildPhotoBuffer(variant);
    childPhotoCache.set(variant, pending);
  }
  const buffer = await pending;
  return {
    name: `child-photo-${variant}.jpg`,
    mimeType: 'image/jpeg',
    buffer,
  };
}

export async function getChildPhotosBatch(
  count: number,
): Promise<E2EFilePayload[]> {
  const results: E2EFilePayload[] = [];
  for (let index = 0; index < count; index += 1) {
    const variant = ((index % 4) + 1) as ChildPhotoVariant;
    const base = await getChildPhotoFixture(variant);
    results.push({
      name: `child-photo-${index + 1}.jpg`,
      mimeType: 'image/jpeg',
      buffer: base.buffer,
    });
  }
  return results;
}

export async function getHighResPhotoFixture(): Promise<E2EFilePayload> {
  if (!highResPhotoCache) {
    highResPhotoCache = (async () => {
      const svg = buildPortraitSvg(1600, 1200, PORTRAIT_PALETTES[1], 3);
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .jpeg({ quality: 92, progressive: false })
        .toBuffer();
      assertJpegMagic(buffer, 'child-photo-highres.jpg');
      return buffer;
    })();
  }
  const buffer = await highResPhotoCache;
  return {
    name: 'child-photo-highres.jpg',
    mimeType: 'image/jpeg',
    buffer,
  };
}

export async function getCustomIllustrationPng(
  variant: 'page' | 'cover' = 'page',
): Promise<E2EFilePayload> {
  let pending = customPngCache.get(variant);
  if (!pending) {
    pending = (async () => {
      const svg = buildStorybookSceneSvg(variant);
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .png({ compressionLevel: 6 })
        .toBuffer();
      assertPngMagic(buffer, `custom-illustration-${variant}.png`);
      return buffer;
    })();
    customPngCache.set(variant, pending);
  }
  const buffer = await pending;
  return {
    name: `custom-illustration-${variant}.png`,
    mimeType: 'image/png',
    buffer,
  };
}

export async function getCustomIllustrationWebp(): Promise<E2EFilePayload> {
  if (!customWebpCache) {
    customWebpCache = (async () => {
      const svg = buildStorybookSceneSvg('webp');
      const buffer = await sharp(Buffer.from(svg))
        .toColorspace('srgb')
        .webp({ quality: 85 })
        .toBuffer();
      assertWebpMagic(buffer, 'custom-illustration.webp');
      return buffer;
    })();
  }
  const buffer = await customWebpCache;
  return {
    name: 'custom-illustration.webp',
    mimeType: 'image/webp',
    buffer,
  };
}

export function getInvalidTextFileFixture(): E2EFilePayload {
  return {
    name: 'not-an-image.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'To nie jest plik graficzny — test odrzucenia nieprawidlowego formatu.',
      'utf-8',
    ),
  };
}

export function getSpoofedJpegFixture(): E2EFilePayload {
  return {
    name: 'spoofed-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(
      'PLAIN TEXT MASQUERADING AS JPEG WITHOUT FF D8 FF MAGIC BYTES',
      'utf-8',
    ),
  };
}

export function getCorruptedJpegFixture(): E2EFilePayload {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const garbage = Buffer.alloc(48, 0x2a);
  return {
    name: 'corrupted-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.concat([header, garbage]),
  };
}
