import { describe, it, expect } from 'vitest';
import {
  encodeGetFileByCID,
  encodeGetBlock,
  encodeGetCid,
  encodeIsRegistered,
  decodeGetCid,
  decodeIsRegistered,
  decodeBlock,
  decodeFileByCID,
} from '../src/background/abi.js';

describe('ABI encoders', () => {
  it('encodeGetFileByCID uses correct selector 0xe37e8f1f', () => {
    const result = encodeGetFileByCID('0x' + 'ab'.repeat(32));
    expect(result.startsWith('0xe37e8f1f')).toBe(true);
    expect(result.length).toBe(2 + 8 + 64 + 64 + 64); // 0x + selector + offset + length + data
  });

  it('encodeGetBlock uses correct selector 0x04c07569', () => {
    const result = encodeGetBlock(42n);
    expect(result.startsWith('0x04c07569')).toBe(true);
    expect(result).toContain('2a'); // 42 in hex
  });

  it('encodeGetCid uses correct selector 0x33e17c60', () => {
    const result = encodeGetCid('twitter');
    expect(result.startsWith('0x33e17c60')).toBe(true);
    // Should contain UTF-8 encoded "twitter"
    const twitterHex = Array.from(new TextEncoder().encode('twitter'))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    expect(result).toContain(twitterHex);
  });

  it('encodeIsRegistered uses correct selector 0xc822d7f0', () => {
    const result = encodeIsRegistered('dgn');
    expect(result.startsWith('0xc822d7f0')).toBe(true);
  });

  it('encodes string length correctly', () => {
    const result = encodeGetCid('test');
    // "test" is 4 bytes, so length word should end with 04
    expect(result).toContain('0000000000000000000000000000000000000000000000000000000000000004');
  });
});

describe('ABI decoders', () => {
  it('decodeIsRegistered returns true for non-zero', () => {
    const hex = '0x' + '0'.repeat(63) + '1';
    expect(decodeIsRegistered(hex)).toBe(true);
  });

  it('decodeIsRegistered returns false for zero', () => {
    const hex = '0x' + '0'.repeat(64);
    expect(decodeIsRegistered(hex)).toBe(false);
  });

  it('decodeGetCid returns null for empty data', () => {
    expect(decodeGetCid('0x')).toBeNull();
    // offset=0x20, length=0
    const empty = '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000';
    expect(decodeGetCid(empty)).toBeNull();
  });

  it('decodeGetCid returns hex CID for valid data', () => {
    // offset=0x20, length=0x20 (32 bytes), data=0xab repeated 32
    const hex = '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      'abababababababababababababababababababababababababababababababababab'.slice(0, 64);
    const result = decodeGetCid(hex);
    expect(result).not.toBeNull();
    expect(result!.startsWith('0x')).toBe(true);
  });

  it('decodeBlock extracts data bytes', () => {
    // Build a valid getBlock response: tuple(uint256 id, bytes data)
    // Outer offset to tuple
    const outerOffset = '0000000000000000000000000000000000000000000000000000000000000020';
    // Tuple: id=1
    const id = '0000000000000000000000000000000000000000000000000000000000000001';
    // Data offset (relative to tuple start): 0x40 = 64 bytes (after id + dataOffset words)
    const dataOffset = '0000000000000000000000000000000000000000000000000000000000000040';
    // Data length: 4 bytes
    const dataLen = '0000000000000000000000000000000000000000000000000000000000000004';
    // Data: [0xde, 0xad, 0xbe, 0xef]
    const data = 'deadbeef' + '0'.repeat(56);

    const hex = '0x' + outerOffset + id + dataOffset + dataLen + data;
    const result = decodeBlock(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(0xde);
    expect(result[1]).toBe(0xad);
    expect(result[2]).toBe(0xbe);
    expect(result[3]).toBe(0xef);
  });

  it('decodeFileByCID extracts file metadata', () => {
    // Outer offset to tuple
    const outerOff = '0000000000000000000000000000000000000000000000000000000000000020';
    // Tuple: id=5
    const id = '0000000000000000000000000000000000000000000000000000000000000005';
    // status=1
    const status = '0000000000000000000000000000000000000000000000000000000000000001';
    // cid offset (relative): 0x80
    const cidOff = '0000000000000000000000000000000000000000000000000000000000000080';
    // blockIds offset (relative): 0xc0
    const blockIdsOff = '00000000000000000000000000000000000000000000000000000000000000c0';
    // cid: length=32, data=aa..
    const cidLen = '0000000000000000000000000000000000000000000000000000000000000020';
    const cidData = 'aa'.repeat(32);
    // blockIds: count=2, [10, 20]
    const blockCount = '0000000000000000000000000000000000000000000000000000000000000002';
    const block1 = '000000000000000000000000000000000000000000000000000000000000000a';
    const block2 = '0000000000000000000000000000000000000000000000000000000000000014';

    const hex = '0x' + outerOff + id + status + cidOff + blockIdsOff + cidLen + cidData + blockCount + block1 + block2;
    const result = decodeFileByCID(hex);
    expect(result.id).toBe(5n);
    expect(result.status).toBe(1);
    expect(result.blockIds).toEqual([10n, 20n]);
  });
});
