import { describe, it, expect } from 'vitest';
import { extractZip } from '../src/background/zip.js';

/**
 * Create a minimal valid ZIP file with a single STORED (uncompressed) entry.
 * ZIP format: local file header + data + central directory + EOCD
 */
function createStoreZip(filename: string, content: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const nameLen = nameBytes.length;
  const dataLen = content.length;

  // Local file header (30 + nameLen bytes)
  const localHeader = new Uint8Array(30 + nameLen + dataLen);
  const lv = new DataView(localHeader.buffer);
  lv.setUint32(0, 0x04034b50, true);   // Local file header signature
  lv.setUint16(4, 20, true);            // Version needed
  lv.setUint16(6, 0, true);             // Flags
  lv.setUint16(8, 0, true);             // Method: STORE
  lv.setUint16(10, 0, true);            // Mod time
  lv.setUint16(12, 0, true);            // Mod date
  lv.setUint32(14, 0, true);            // CRC-32 (0 for simplicity)
  lv.setUint32(18, dataLen, true);       // Compressed size
  lv.setUint32(22, dataLen, true);       // Uncompressed size
  lv.setUint16(26, nameLen, true);       // Filename length
  lv.setUint16(28, 0, true);            // Extra field length
  localHeader.set(nameBytes, 30);
  localHeader.set(content, 30 + nameLen);

  // Central directory entry (46 + nameLen bytes)
  const cdEntry = new Uint8Array(46 + nameLen);
  const cv = new DataView(cdEntry.buffer);
  cv.setUint32(0, 0x02014b50, true);   // Central directory signature
  cv.setUint16(4, 20, true);            // Version made by
  cv.setUint16(6, 20, true);            // Version needed
  cv.setUint16(8, 0, true);             // Flags
  cv.setUint16(10, 0, true);            // Method: STORE
  cv.setUint16(12, 0, true);            // Mod time
  cv.setUint16(14, 0, true);            // Mod date
  cv.setUint32(16, 0, true);            // CRC-32
  cv.setUint32(20, dataLen, true);       // Compressed size
  cv.setUint32(24, dataLen, true);       // Uncompressed size
  cv.setUint16(28, nameLen, true);       // Filename length
  cv.setUint16(30, 0, true);            // Extra length
  cv.setUint16(32, 0, true);            // Comment length
  cv.setUint16(34, 0, true);            // Disk number start
  cv.setUint16(36, 0, true);            // Internal attrs
  cv.setUint32(38, 0, true);            // External attrs
  cv.setUint32(42, 0, true);            // Local header offset
  cdEntry.set(nameBytes, 46);

  const cdOffset = localHeader.length;
  const cdSize = cdEntry.length;

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);   // EOCD signature
  ev.setUint16(4, 0, true);             // Disk number
  ev.setUint16(6, 0, true);             // Disk with CD
  ev.setUint16(8, 1, true);             // Entries on this disk
  ev.setUint16(10, 1, true);            // Total entries
  ev.setUint32(12, cdSize, true);        // CD size
  ev.setUint32(16, cdOffset, true);      // CD offset
  ev.setUint16(20, 0, true);            // Comment length

  // Combine all parts
  const zip = new Uint8Array(localHeader.length + cdEntry.length + eocd.length);
  zip.set(localHeader, 0);
  zip.set(cdEntry, localHeader.length);
  zip.set(eocd, localHeader.length + cdEntry.length);
  return zip;
}

describe('extractZip', () => {
  it('extracts a single STORED file', () => {
    const content = new TextEncoder().encode('Hello, EVMFS!');
    const zip = createStoreZip('hello.txt', content);

    const entries = extractZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('hello.txt');
    expect(entries[0].mime).toBe('text/plain');
    expect(new TextDecoder().decode(entries[0].data)).toBe('Hello, EVMFS!');
  });

  it('assigns correct MIME types', () => {
    const zip = createStoreZip('style.css', new TextEncoder().encode('body{}'));
    const entries = extractZip(zip);
    expect(entries[0].mime).toBe('text/css');
  });

  it('throws on invalid ZIP', () => {
    expect(() => extractZip(new Uint8Array([0, 1, 2, 3]))).toThrow();
  });

  it('skips directory entries', () => {
    // Directory entries end with /
    const zip = createStoreZip('assets/', new Uint8Array(0));
    const entries = extractZip(zip);
    expect(entries).toHaveLength(0);
  });
});
