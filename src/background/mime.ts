const MIME_MAP: Record<string, string> = {
  html: 'text/html', htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript', mjs: 'application/javascript',
  json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  wasm: 'application/wasm',
  txt: 'text/plain', xml: 'application/xml',
  pdf: 'application/pdf', zip: 'application/zip',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};

export function getMime(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** Detect if raw bytes are a ZIP file (PK\x03\x04 magic) */
export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** Sniff MIME type from magic bytes (for raw CID files without extension) */
export function sniffMime(data: Uint8Array): string {
  if (data.length < 4) return 'application/octet-stream';
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'image/webp';
  if (data[0] === 0x50 && data[1] === 0x4b) return 'application/zip';
  if (data[0] === 0x25 && data[1] === 0x50) return 'application/pdf';
  // Check for HTML/text
  const head = new TextDecoder('utf-8', { fatal: false }).decode(data.slice(0, 256));
  if (head.trimStart().startsWith('<!') || head.trimStart().startsWith('<html')) return 'text/html';
  if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) return 'application/json';
  return 'application/octet-stream';
}
