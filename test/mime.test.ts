import { describe, it, expect } from 'vitest';
import { getMime, isZip, sniffMime } from '../src/background/mime.js';

describe('getMime', () => {
  it('returns correct MIME for known extensions', () => {
    expect(getMime('index.html')).toBe('text/html');
    expect(getMime('style.css')).toBe('text/css');
    expect(getMime('app.js')).toBe('application/javascript');
    expect(getMime('data.json')).toBe('application/json');
    expect(getMime('photo.png')).toBe('image/png');
    expect(getMime('photo.jpg')).toBe('image/jpeg');
    expect(getMime('icon.svg')).toBe('image/svg+xml');
    expect(getMime('font.woff2')).toBe('font/woff2');
    expect(getMime('module.wasm')).toBe('application/wasm');
    expect(getMime('video.mp4')).toBe('video/mp4');
  });

  it('handles paths with directories', () => {
    expect(getMime('assets/vendor-abc123.js')).toBe('application/javascript');
    expect(getMime('deep/nested/path/style.css')).toBe('text/css');
  });

  it('is case-insensitive for extensions', () => {
    expect(getMime('FILE.HTML')).toBe('text/html');
    expect(getMime('IMAGE.PNG')).toBe('image/png');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getMime('file.xyz')).toBe('application/octet-stream');
    expect(getMime('noext')).toBe('application/octet-stream');
  });
});

describe('isZip', () => {
  it('detects ZIP magic bytes (PK\\x03\\x04)', () => {
    expect(isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
  });

  it('rejects non-ZIP data', () => {
    expect(isZip(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isZip(new Uint8Array([0x00, 0x00]))).toBe(false);
  });

  it('rejects data shorter than 4 bytes', () => {
    expect(isZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

describe('sniffMime', () => {
  it('detects PNG', () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
  });

  it('detects JPEG', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('detects GIF', () => {
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
  });

  it('detects ZIP', () => {
    expect(sniffMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
  });

  it('detects PDF', () => {
    expect(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
  });

  it('detects HTML from content', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html>');
    expect(sniffMime(html)).toBe('text/html');
  });

  it('detects JSON from content', () => {
    const json = new TextEncoder().encode('{"key": "value"}');
    expect(sniffMime(json)).toBe('application/json');
  });

  it('returns octet-stream for unknown data', () => {
    expect(sniffMime(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe('application/octet-stream');
  });
});
