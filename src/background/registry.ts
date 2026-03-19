import { ChainConfig, CHAINS } from './chains.js';
import { rpcCall } from './rpc.js';
import { encodeGetCid, encodeIsRegistered, decodeGetCid, decodeIsRegistered } from './abi.js';

export interface ResolvedAlias {
  cid: string;
  chain: ChainConfig;
}

/**
 * Resolve a site alias (e.g. "twitter") to a CID by querying
 * the EVMFSRegistry on all configured chains.
 *
 * If preferredChainId is set, that chain is tried first.
 * Otherwise, queries all chains in parallel and returns the first match.
 */
export async function resolveAlias(
  name: string,
  preferredChainId?: number,
): Promise<ResolvedAlias | null> {
  // Order chains with preferred first
  const ordered = preferredChainId
    ? [...CHAINS].sort((a, b) => (a.chainId === preferredChainId ? -1 : b.chainId === preferredChainId ? 1 : 0))
    : CHAINS;

  // Query all chains in parallel
  const results = await Promise.allSettled(
    ordered.map(async (chain): Promise<ResolvedAlias | null> => {
      const regResult = await rpcCall(
        chain.rpcUrl,
        chain.registryContract,
        encodeIsRegistered(name),
      );
      if (!decodeIsRegistered(regResult)) return null;

      const cidResult = await rpcCall(
        chain.rpcUrl,
        chain.registryContract,
        encodeGetCid(name),
      );
      const cid = decodeGetCid(cidResult);
      if (!cid) return null;

      return { cid, chain };
    }),
  );

  // Return first successful match (preferred chain comes first)
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}

/**
 * Try to find a CID on any chain (for direct CID access).
 * Returns the chain config where the file exists.
 */
export async function findCIDOnChain(
  cid: string,
  preferredChainId?: number,
): Promise<ChainConfig | null> {
  const ordered = preferredChainId
    ? [...CHAINS].sort((a, b) => (a.chainId === preferredChainId ? -1 : b.chainId === preferredChainId ? 1 : 0))
    : CHAINS;

  // Try chains in parallel
  const results = await Promise.allSettled(
    ordered.map(async (chain): Promise<ChainConfig | null> => {
      const { encodeGetFileByCID, decodeFileByCID } = await import('./abi.js');
      const raw = await rpcCall(chain.rpcUrl, chain.evmfsContract, encodeGetFileByCID(cid));
      const { id } = decodeFileByCID(raw);
      return id !== 0n ? chain : null;
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}
