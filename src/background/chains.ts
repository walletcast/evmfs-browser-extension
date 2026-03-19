export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  blockContract: string;
  evmfsContract: string;
  registryContract: string;
}

export const CHAINS: ChainConfig[] = [
  {
    chainId: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    blockContract: '0x4571D19Ada5Ec6853bd7Bef5fBe9F0f94238419c',
    evmfsContract: '0xDb0CBFd5ceFB148f606Ae3b61B4d944e430F2f2A',
    registryContract: '0x1DC0fe8Ad09F4FB6f36c5DEC81f4975fb3a85999',
  },
  {
    chainId: 167013,
    name: 'Taiko Hoodi',
    rpcUrl: 'https://rpc.hoodi.taiko.xyz',
    blockContract: '0x32DB8E8Eeb4A8Fec859fDAC5A6222608D847DB7F',
    evmfsContract: '0x36bF7216C9F23dc9a2433B75B7be7971d3f78b47',
    registryContract: '0xc4aca772da000649003951Fd3E9FF65b5001C008',
  },
];

export function getChainById(chainId: number): ChainConfig | undefined {
  return CHAINS.find(c => c.chainId === chainId);
}
