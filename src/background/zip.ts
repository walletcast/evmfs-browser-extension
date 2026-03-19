import { getMime } from './mime.js';

export interface ZipEntry {
  path: string;
  data: Uint8Array;
  mime: string;
}

/**
 * Extract all files from a ZIP archive (pure TypeScript, no dependencies).
 * Supports STORE (method 0) and DEFLATE (method 8) compression.
 */
export function extractZip(zipData: Uint8Array): ZipEntry[] {
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const entries: ZipEntry[] = [];

  // Find end of central directory record (search backwards for signature 0x06054b50)
  let eocdOff = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff === -1) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = view.getUint32(eocdOff + 16, true);
  const cdEntries = view.getUint16(eocdOff + 10, true);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid central directory entry');

    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOff = view.getUint32(pos + 42, true);

    const nameBytes = zipData.slice(pos + 46, pos + 46 + nameLen);
    const path = new TextDecoder().decode(nameBytes);

    pos += 46 + nameLen + extraLen + commentLen;

    // Skip directories
    if (path.endsWith('/')) continue;

    // Read local file header to get actual data offset
    if (view.getUint32(localHeaderOff, true) !== 0x04034b50) throw new Error('Invalid local file header');
    const localNameLen = view.getUint16(localHeaderOff + 26, true);
    const localExtraLen = view.getUint16(localHeaderOff + 28, true);
    const dataOff = localHeaderOff + 30 + localNameLen + localExtraLen;

    const compressed = zipData.slice(dataOff, dataOff + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      // STORE — no compression
      data = compressed;
    } else if (method === 8) {
      // DEFLATE
      data = inflate(compressed, uncompressedSize);
    } else {
      throw new Error(`Unsupported compression method: ${method}`);
    }

    entries.push({ path, data, mime: getMime(path) });
  }

  return entries;
}

// ── DEFLATE Inflater ────────────────────────────────────────────
// Implements RFC 1951 raw DEFLATE decompression.

/** Inflate raw DEFLATE data (no zlib/gzip header) */
function inflate(src: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize);
  let outPos = 0;
  const bits = new BitReader(src);

  let bfinal = 0;
  while (!bfinal) {
    bfinal = bits.read(1);
    const btype = bits.read(2);

    if (btype === 0) {
      // Uncompressed block
      bits.flushByte();
      const len = bits.read(16);
      bits.read(16); // nlen (complement, skip)
      for (let i = 0; i < len; i++) {
        out[outPos++] = bits.read(8);
      }
    } else if (btype === 1) {
      // Fixed Huffman
      outPos = inflateBlock(bits, FIXED_LIT_TREE, FIXED_DIST_TREE, out, outPos);
    } else if (btype === 2) {
      // Dynamic Huffman
      const { litTree, distTree } = decodeDynamicTrees(bits);
      outPos = inflateBlock(bits, litTree, distTree, out, outPos);
    } else {
      throw new Error('Invalid DEFLATE block type: ' + btype);
    }
  }

  return out.slice(0, outPos);
}

function inflateBlock(
  bits: BitReader,
  litTree: HuffmanTree,
  distTree: HuffmanTree,
  out: Uint8Array,
  outPos: number,
): number {
  while (true) {
    const sym = decodeSymbol(bits, litTree);
    if (sym < 256) {
      out[outPos++] = sym;
    } else if (sym === 256) {
      return outPos; // End of block
    } else {
      // Length/distance pair
      const lenIdx = sym - 257;
      const length = LEN_BASE[lenIdx] + bits.read(LEN_EXTRA[lenIdx]);
      const distSym = decodeSymbol(bits, distTree);
      const distance = DIST_BASE[distSym] + bits.read(DIST_EXTRA[distSym]);

      // Copy from back-reference
      for (let i = 0; i < length; i++) {
        out[outPos] = out[outPos - distance];
        outPos++;
      }
    }
  }
}

// ── Bit reader ──────────────────────────────────────────────────

class BitReader {
  private data: Uint8Array;
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  read(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new Error('Unexpected end of DEFLATE data');
      this.bitBuf |= this.data[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const val = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return val;
  }

  flushByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }
}

// ── Huffman tree ────────────────────────────────────────────────

interface HuffmanTree {
  counts: Uint16Array;   // Number of codes at each bit length
  symbols: Uint16Array;  // Symbols sorted by code
  maxBits: number;
}

function buildHuffmanTree(codeLengths: number[], maxSymbols: number): HuffmanTree {
  let maxBits = 0;
  for (const cl of codeLengths) if (cl > maxBits) maxBits = cl;
  if (maxBits === 0) maxBits = 1;

  const counts = new Uint16Array(maxBits + 1);
  for (const cl of codeLengths) if (cl > 0) counts[cl]++;

  // Compute offsets
  const offsets = new Uint16Array(maxBits + 1);
  for (let i = 1; i <= maxBits; i++) {
    offsets[i] = offsets[i - 1] + counts[i - 1];
  }

  const symbols = new Uint16Array(offsets[maxBits] + counts[maxBits]);
  for (let sym = 0; sym < maxSymbols; sym++) {
    const cl = codeLengths[sym];
    if (cl > 0) {
      symbols[offsets[cl]++] = sym;
    }
  }

  // Reset offsets for decode
  for (let i = maxBits; i >= 1; i--) {
    offsets[i] = offsets[i - 1];
  }
  offsets[0] = 0;

  return { counts, symbols, maxBits };
}

function decodeSymbol(bits: BitReader, tree: HuffmanTree): number {
  let code = 0;
  let first = 0;
  let index = 0;

  for (let len = 1; len <= tree.maxBits; len++) {
    code |= bits.read(1);
    const count = tree.counts[len];
    if (code < first + count) {
      return tree.symbols[index + code - first];
    }
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('Invalid Huffman code');
}

// ── Dynamic Huffman trees ───────────────────────────────────────

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function decodeDynamicTrees(bits: BitReader): { litTree: HuffmanTree; distTree: HuffmanTree } {
  const hlit = bits.read(5) + 257;
  const hdist = bits.read(5) + 1;
  const hclen = bits.read(4) + 4;

  // Code length code lengths
  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) {
    clLengths[CL_ORDER[i]] = bits.read(3);
  }

  const clTree = buildHuffmanTree(clLengths, 19);

  // Decode literal/length + distance code lengths
  const totalCodes = hlit + hdist;
  const codeLengths: number[] = [];

  while (codeLengths.length < totalCodes) {
    const sym = decodeSymbol(bits, clTree);
    if (sym < 16) {
      codeLengths.push(sym);
    } else if (sym === 16) {
      const repeat = bits.read(2) + 3;
      const prev = codeLengths[codeLengths.length - 1];
      for (let i = 0; i < repeat; i++) codeLengths.push(prev);
    } else if (sym === 17) {
      const repeat = bits.read(3) + 3;
      for (let i = 0; i < repeat; i++) codeLengths.push(0);
    } else if (sym === 18) {
      const repeat = bits.read(7) + 11;
      for (let i = 0; i < repeat; i++) codeLengths.push(0);
    }
  }

  const litTree = buildHuffmanTree(codeLengths.slice(0, hlit), hlit);
  const distTree = buildHuffmanTree(codeLengths.slice(hlit), hdist);

  return { litTree, distTree };
}

// ── Fixed Huffman tables ────────────────────────────────────────

function buildFixedLitTree(): HuffmanTree {
  const lengths: number[] = new Array(288);
  for (let i = 0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  return buildHuffmanTree(lengths, 288);
}

function buildFixedDistTree(): HuffmanTree {
  const lengths = new Array(32).fill(5);
  return buildHuffmanTree(lengths, 32);
}

const FIXED_LIT_TREE = buildFixedLitTree();
const FIXED_DIST_TREE = buildFixedDistTree();

// ── Length/distance tables (RFC 1951) ───────────────────────────

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
