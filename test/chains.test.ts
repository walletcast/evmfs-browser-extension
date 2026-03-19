import { describe, it, expect } from 'vitest';
import { CHAINS, getChainById } from '../src/background/chains.js';

describe('chains', () => {
  it('has Sepolia and Taiko Hoodi configured', () => {
    expect(CHAINS.length).toBeGreaterThanOrEqual(2);
    expect(CHAINS.find(c => c.name === 'Sepolia')).toBeDefined();
    expect(CHAINS.find(c => c.name === 'Taiko Hoodi')).toBeDefined();
  });

  it('each chain has all required fields', () => {
    for (const chain of CHAINS) {
      expect(chain.chainId).toBeTypeOf('number');
      expect(chain.name).toBeTypeOf('string');
      expect(chain.rpcUrl).toMatch(/^https?:\/\//);
      expect(chain.blockContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(chain.evmfsContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(chain.registryContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('getChainById finds Sepolia', () => {
    const chain = getChainById(11155111);
    expect(chain).toBeDefined();
    expect(chain!.name).toBe('Sepolia');
  });

  it('getChainById returns undefined for unknown chain', () => {
    expect(getChainById(999999)).toBeUndefined();
  });
});
