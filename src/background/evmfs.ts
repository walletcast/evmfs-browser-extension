import { ChainConfig } from './chains.js';
import { rpcCall } from './rpc.js';
import { encodeGetFileByCID, encodeGetBlock, decodeFileByCID, decodeBlock } from './abi.js';
import { verifyCID } from './crypto.js';

export type ProgressCallback = (stage: string, percent: number) => void;

/**
 * Fetch an EVMFS file from chain by CID.
 * Fetches blocks one-by-one to stay within per-call gas limits.
 * Returns the raw concatenated bytes after CID verification.
 */
export async function fetchEVMFSFile(
  chain: ChainConfig,
  cid: string,
  progressCb?: ProgressCallback,
): Promise<Uint8Array> {
  progressCb?.('Querying file metadata', 5);

  const fileMeta = await rpcCall(chain.rpcUrl, chain.evmfsContract, encodeGetFileByCID(cid));
  const { id: fileId, status, blockIds } = decodeFileByCID(fileMeta);

  if (fileId === 0n) throw new Error('File not found for CID');
  if (status !== 1) throw new Error('File not yet finalized (status=' + status + ')');

  progressCb?.('Fetching blocks', 15);

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < blockIds.length; i++) {
    const blockRaw = await rpcCall(chain.rpcUrl, chain.blockContract, encodeGetBlock(blockIds[i]));
    chunks.push(decodeBlock(blockRaw));
    if (i % 5 === 0) {
      progressCb?.(
        `Fetching blocks (${i + 1}/${blockIds.length})`,
        15 + Math.floor((i / blockIds.length) * 25),
      );
    }
  }

  progressCb?.('Verifying CID', 45);

  const valid = await verifyCID(chunks, cid);
  if (!valid) throw new Error('CID verification failed — data may be corrupted');

  progressCb?.('Reassembling', 50);

  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }

  return buf;
}
