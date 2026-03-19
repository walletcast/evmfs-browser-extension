// ── Hardcoded function selectors (verified via `cast sig`) ──────
// getFileByCID(bytes)   → 0xe37e8f1f
// getBlock(uint256)     → 0x04c07569
// getCid(string)        → 0x33e17c60
// isRegistered(string)  → 0xc822d7f0

// ── Encoders ────────────────────────────────────────────────────

/** Encode EVMFS.getFileByCID(bytes cid) — cid is exactly 32 bytes */
export function encodeGetFileByCID(cidHex: string): string {
  const sel = 'e37e8f1f';
  const offset = '0000000000000000000000000000000000000000000000000000000000000020';
  const length = '0000000000000000000000000000000000000000000000000000000000000020';
  const data = cidHex.replace('0x', '').padEnd(64, '0');
  return '0x' + sel + offset + length + data;
}

/** Encode Block.getBlock(uint256 blockId) */
export function encodeGetBlock(blockId: bigint): string {
  const sel = '04c07569';
  const id = blockId.toString(16).padStart(64, '0');
  return '0x' + sel + id;
}

/** Encode EVMFSRegistry.getCid(string name) */
export function encodeGetCid(name: string): string {
  const sel = '33e17c60';
  return '0x' + sel + encodeString(name);
}

/** Encode EVMFSRegistry.isRegistered(string name) */
export function encodeIsRegistered(name: string): string {
  const sel = 'c822d7f0';
  return '0x' + sel + encodeString(name);
}

/** ABI-encode a string argument (offset + length + padded UTF-8 data) */
function encodeString(s: string): string {
  const nameBytes = new TextEncoder().encode(s);
  const offset = '0000000000000000000000000000000000000000000000000000000000000020';
  const length = nameBytes.length.toString(16).padStart(64, '0');
  const dataHex = Array.from(nameBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const padded = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64 || 64, '0');
  return offset + length + padded;
}

// ── Decoders ────────────────────────────────────────────────────

export interface FileMeta {
  id: bigint;
  status: number;
  blockIds: bigint[];
}

/** Decode getFileByCID return: (uint256 id, uint8 status, bytes cid, uint256[] blockIds) */
export function decodeFileByCID(hex: string): FileMeta {
  const d = hex.replace('0x', '');
  // Outer ABI: one word offset pointing to the tuple
  const tupleOffset = parseInt(d.slice(0, 64), 16) * 2;
  const t = d.slice(tupleOffset);

  const id = BigInt('0x' + t.slice(0, 64));
  const status = parseInt(t.slice(64, 128), 16);

  // blockIds: dynamic array at offset in word 3
  const blockIdsRelOff = parseInt(t.slice(192, 256), 16) * 2;
  const blockIdsSec = t.slice(blockIdsRelOff);
  const blockCount = parseInt(blockIdsSec.slice(0, 64), 16);
  const blockIds: bigint[] = [];
  for (let i = 0; i < blockCount; i++) {
    blockIds.push(BigInt('0x' + blockIdsSec.slice(64 + i * 64, 128 + i * 64)));
  }

  return { id, status, blockIds };
}

/** Decode Block.getBlock return: tuple(uint256 id, bytes data) → Uint8Array */
export function decodeBlock(hex: string): Uint8Array {
  const d = hex.replace('0x', '');
  const tupleOff = parseInt(d.slice(0, 64), 16) * 2;
  const t = d.slice(tupleOff);

  const dataRelOff = parseInt(t.slice(64, 128), 16) * 2;
  const dataSec = t.slice(dataRelOff);
  const dataLen = parseInt(dataSec.slice(0, 64), 16);
  const dataHex = dataSec.slice(64, 64 + dataLen * 2);

  const bytes = new Uint8Array(dataLen);
  for (let j = 0; j < dataLen; j++) {
    bytes[j] = parseInt(dataHex.slice(j * 2, j * 2 + 2), 16);
  }
  return bytes;
}

/** Decode getCid return: bytes memory → hex string or null if empty */
export function decodeGetCid(hex: string): string | null {
  const d = hex.replace('0x', '');
  if (d.length < 128) return null;

  // bytes memory: offset + length + data
  const offset = parseInt(d.slice(0, 64), 16) * 2;
  const sec = d.slice(offset);
  const len = parseInt(sec.slice(0, 64), 16);
  if (len === 0) return null;

  const dataHex = sec.slice(64, 64 + len * 2);
  return '0x' + dataHex;
}

/** Decode isRegistered return: bool */
export function decodeIsRegistered(hex: string): boolean {
  const d = hex.replace('0x', '');
  return parseInt(d.slice(-64), 16) !== 0;
}
