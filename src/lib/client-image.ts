'use client';

import type { BookFormat } from '@/lib/types/story';

const ALLOWED_BROWSER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.84;

export interface CompressedPhotoResult {
  file: File;
  previewUrl: string;
}

function loadImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Nie udało się odczytać obrazu.'));
    img.src = objectUrl;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Compresses a browser File via <canvas> into an optimized JPEG (keeping payload
 * comfortably below Vercel's 4.5 MB serverless limit). Rejects non-image files.
 */
export async function compressChildPhoto(
  inputFile: File,
): Promise<CompressedPhotoResult> {
  const mimeLower = inputFile.type.toLowerCase();
  if (mimeLower && !ALLOWED_BROWSER_MIMES.has(mimeLower)) {
    throw new Error(
      `Plik „${inputFile.name}” nie jest obsługiwanym zdjęciem (dozwolone: JPG, PNG, WebP).`,
    );
  }

  const objectUrl = URL.createObjectURL(inputFile);
  try {
    const img = await loadImageElement(objectUrl);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) {
      throw new Error(`Plik „${inputFile.name}” nie zawiera prawidłowego obrazu.`);
    }

    const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { file: inputFile, previewUrl: objectUrl };
    }

    ctx.fillStyle = '#FAF6EE';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (!blob) {
      return { file: inputFile, previewUrl: objectUrl };
    }

    const baseName = inputFile.name.replace(/\.[^.]+$/, '') || 'zdjecie';
    const compressedFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
    });
    URL.revokeObjectURL(objectUrl);
    const previewUrl = URL.createObjectURL(compressedFile);
    return { file: compressedFile, previewUrl };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * Fetches binary PDF from the API route and triggers a true Blob attachment download
 * so the browser NEVER renders raw %PDF- bytes in the document viewport.
 */
export interface PdfDownloadOptions {
  bleedMm?: number;
  cropMarks?: boolean;
  padToMultipleOf4?: boolean;
  layoutMode?: 'combined' | 'interior' | 'cover-wrap';
}

export async function downloadStoryPdfBinary(
  storyId: string,
  format: BookFormat,
  fallbackSlug = 'bajka',
  options?: PdfDownloadOptions,
): Promise<void> {
  const params = new URLSearchParams({ format });
  if (options?.bleedMm !== undefined && options.bleedMm > 0) {
    params.set('bleedMm', String(options.bleedMm));
  }
  if (options?.cropMarks) {
    params.set('cropMarks', 'true');
  }
  if (options?.padToMultipleOf4) {
    params.set('padToMultipleOf4', 'true');
  }
  if (options?.layoutMode && options.layoutMode !== 'combined') {
    params.set('layoutMode', options.layoutMode);
  }

  const url = `/api/stories/${encodeURIComponent(storyId)}/pdf?${params.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/pdf' },
    cache: 'no-store',
  });

  if (!res.ok) {
    let message = `Nie udało się pobrać PDF (kod ${res.status}).`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(message);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/pdf')) {
    throw new Error('Serwer nie zwrócił prawidłowego pliku PDF.');
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/i.exec(disposition);
  const filename = match?.[1] ?? `bajka-${fallbackSlug}-${format}.pdf`;

  const blobUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }
}

/**
 * Copies text to clipboard with execCommand fallback for restricted contexts.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to textarea fallback
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
