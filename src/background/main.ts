import { CHAINS, getChainById, type ChainConfig } from './chains.js';
import { fetchEVMFSFile } from './evmfs.js';
import { resolveAlias, findCIDOnChain } from './registry.js';
import { cacheFile, getCachedFile, cacheSiteFile, cacheAlias, getCachedAlias } from './cache.js';
import { isZip, sniffMime } from './mime.js';
import { extractZip } from './zip.js';

/** Extract a proper ArrayBuffer from a Uint8Array (handles SharedArrayBuffer) */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

// ── _evmfs.json dependency resolution ───────────────────────────
// Sites deployed with split mode have a _evmfs.json manifest that
// lists dependency CIDs (vendor/crypto/ui chunks in a separate ZIP).

interface EvmfsManifest {
  version: number;
  deps?: Array<{ cid: string; label?: string }>;
}

/** Parse _evmfs.json from ZIP entries and return dep CIDs */
function parseEvmfsManifest(entries: Array<{ path: string; data: Uint8Array }>): string[] {
  const manifestEntry = entries.find(e => e.path === '_evmfs.json');
  if (!manifestEntry) return [];
  try {
    const manifest: EvmfsManifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
    if (manifest.deps && Array.isArray(manifest.deps)) {
      return manifest.deps.map(d => d.cid).filter(Boolean);
    }
  } catch {
    console.warn('[EVMFS] Failed to parse _evmfs.json');
  }
  return [];
}

/** Fetch and extract dependency ZIPs, merging their files into the main entries */
async function resolveDepZips(
  depCids: string[],
  chain: ChainConfig,
  sendProgress: (stage: string, percent: number) => void,
): Promise<Array<{ path: string; data: Uint8Array; mime: string }>> {
  const allDepFiles: Array<{ path: string; data: Uint8Array; mime: string }> = [];

  for (let i = 0; i < depCids.length; i++) {
    const depCid = depCids[i];
    sendProgress(`Fetching deps ${i + 1}/${depCids.length}`, 60 + (i / depCids.length) * 30);

    // Check cache first
    const cached = await getCachedFile(depCid);
    let depData: Uint8Array;
    if (cached) {
      depData = new Uint8Array(cached.data);
    } else {
      depData = await fetchEVMFSFile(chain, depCid, (stage, pct) => {
        sendProgress(`Deps: ${stage}`, 60 + (pct / 100) * 30);
      });
      await cacheFile(depCid, depData, 'application/zip');
    }

    if (isZip(depData)) {
      const depEntries = extractZip(depData);
      allDepFiles.push(...depEntries);
    }
  }

  return allDepFiles;
}

// ── URL parsing ─────────────────────────────────────────────────

interface ParsedUrl {
  type: 'cid' | 'alias';
  value: string;
  path?: string;
}

function parseEvmfsInput(input: string): ParsedUrl {
  let clean = input.replace(/^evmfs:\/\//, '').replace(/^\/+/, '');

  // Direct CID: 0x + 64 hex chars
  const cidMatch = clean.match(/^(0x[0-9a-fA-F]{64})(\/(.*))?$/);
  if (cidMatch) {
    return { type: 'cid', value: cidMatch[1], path: cidMatch[3] };
  }

  // Alias: name[/path]
  const slashIdx = clean.indexOf('/');
  if (slashIdx >= 0) {
    return { type: 'alias', value: clean.slice(0, slashIdx), path: clean.slice(slashIdx + 1) || undefined };
  }
  return { type: 'alias', value: clean };
}

// ── Preferred chain ─────────────────────────────────────────────

async function getPreferredChainId(): Promise<number | undefined> {
  const result = await chrome.storage.local.get('preferredChainId');
  return result.preferredChainId;
}

// ── Main load handler ───────────────────────────────────────────

interface LoadResult {
  type: 'raw' | 'site';
  mime?: string;
  data?: ArrayBuffer;
  files?: Array<{ path: string; mime: string; data: ArrayBuffer }>;
  cid: string;
  chainName: string;
}

async function loadEvmfs(
  input: string,
  sendProgress: (stage: string, percent: number) => void,
): Promise<LoadResult> {
  const parsed = parseEvmfsInput(input);
  const preferredChainId = await getPreferredChainId();
  let cid: string;
  let chainName: string;

  if (parsed.type === 'alias') {
    sendProgress(`Resolving "${parsed.value}"`, 2);

    // Check cache first
    const cached = await getCachedAlias(parsed.value);
    if (cached) {
      cid = cached.cid;
      const chain = getChainById(cached.chainId);
      chainName = chain?.name ?? 'Unknown';
      sendProgress(`Cached: ${chainName}`, 5);
    } else {
      const result = await resolveAlias(parsed.value, preferredChainId);
      if (!result) throw new Error(`Name "${parsed.value}" not registered on any chain`);
      cid = result.cid;
      chainName = result.chain.name;
      await cacheAlias(parsed.value, cid, result.chain.chainId);
    }
  } else {
    cid = parsed.value;
    sendProgress('Finding CID on chain', 2);
    const chain = await findCIDOnChain(cid, preferredChainId);
    if (!chain) throw new Error('CID not found on any configured chain');
    chainName = chain.name;
  }

  // Resolve the chain we'll use for fetching
  const maybeChain = getChainById(
    (await getCachedAlias(parsed.type === 'alias' ? parsed.value : ''))?.chainId ?? 0,
  ) ?? (await findCIDOnChain(cid, preferredChainId));

  if (!maybeChain) throw new Error('Chain not found');
  const chain: ChainConfig = maybeChain;

  // Helper: given extracted entries, resolve _evmfs.json deps and merge
  async function resolveAndMerge(
    entries: Array<{ path: string; data: Uint8Array; mime: string }>,
  ): Promise<Array<{ path: string; mime: string; data: ArrayBuffer }>> {
    // Check for _evmfs.json manifest with dependency CIDs
    const depCids = parseEvmfsManifest(entries);
    let allEntries = entries;

    if (depCids.length > 0) {
      sendProgress('Loading dependency chunks', 60);
      const depFiles = await resolveDepZips(depCids, chain, sendProgress);
      // Merge: dep files first, then app files (app files override deps on conflict)
      const merged = new Map<string, { path: string; data: Uint8Array; mime: string }>();
      for (const f of depFiles) merged.set(f.path, f);
      for (const f of allEntries) merged.set(f.path, f);
      allEntries = Array.from(merged.values());
    }

    return allEntries
      .filter(e => e.path !== '_evmfs.json')
      .map(e => ({ path: e.path, mime: e.mime, data: toArrayBuffer(e.data) }));
  }

  // Check file cache
  const cachedFile = await getCachedFile(cid);
  if (cachedFile) {
    sendProgress('Loaded from cache', 50);
    const data = new Uint8Array(cachedFile.data);
    if (isZip(data)) {
      const entries = extractZip(data);
      const files = await resolveAndMerge(entries);
      sendProgress('Ready', 100);
      return { type: 'site', files, cid, chainName };
    }
    return { type: 'raw', mime: cachedFile.mime, data: cachedFile.data, cid, chainName };
  }

  // Fetch from chain
  const rawData = await fetchEVMFSFile(chain, cid, sendProgress);

  if (isZip(rawData)) {
    sendProgress('Decompressing ZIP', 55);
    const entries = extractZip(rawData);

    // Cache the raw zip
    await cacheFile(cid, rawData, 'application/zip');

    const files = await resolveAndMerge(entries);

    sendProgress('Ready', 100);
    return { type: 'site', files, cid, chainName };
  }

  // Raw file
  const mime = sniffMime(rawData);
  await cacheFile(cid, rawData, mime);

  sendProgress('Ready', 100);
  return {
    type: 'raw',
    mime,
    data: toArrayBuffer(rawData),
    cid,
    chainName,
  };
}

// ── Open viewer tab ─────────────────────────────────────────────

function openViewer(query: string): void {
  const url = chrome.runtime.getURL(`viewer.html?q=${encodeURIComponent(query)}`);
  chrome.tabs.create({ url });
}

// ── Omnibox ─────────────────────────────────────────────────────

chrome.omnibox.onInputEntered.addListener((text) => {
  openViewer(text.trim());
});

chrome.omnibox.setDefaultSuggestion({
  description: 'Load EVMFS content: <match>%s</match>',
});

// ── Intercept evmfs:// and *.evmfs / *.evm URLs ────────────────

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  // evmfs:// protocol
  if (details.url.startsWith('evmfs://')) {
    const query = details.url.replace('evmfs://', '');
    chrome.tabs.update(details.tabId, {
      url: chrome.runtime.getURL(`viewer.html?q=${encodeURIComponent(query)}`),
    });
    return;
  }

  // *.evmfs or *.evm TLDs (e.g. http://twitter.evmfs, https://0xabc...def.evm)
  try {
    const url = new URL(details.url);
    const host = url.hostname;
    if (host.endsWith('.evmfs') || host.endsWith('.evm')) {
      const alias = host.replace(/\.(evmfs|evm)$/, '');
      const path = url.pathname !== '/' ? url.pathname : '';
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL(`viewer.html?q=${encodeURIComponent(alias + path)}`),
      });
    }
  } catch {
    // ignore malformed URLs
  }
});

// ── declarativeNetRequest: redirect *.evmfs / *.evm to viewer ──
// Dynamic rules registered at install time capture requests even before
// webNavigation fires (prevents DNS-error pages).

chrome.runtime.onInstalled.addListener(() => {
  const viewerBase = chrome.runtime.getURL('viewer.html');

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
          redirect: {
            regexSubstitution: `${viewerBase}?q=\\1`,
          },
        },
        condition: {
          regexFilter: '^https?://([^/]+)\\.evmfs(?:/(.*))?$',
          resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
        },
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
          redirect: {
            regexSubstitution: `${viewerBase}?q=\\1`,
          },
        },
        condition: {
          regexFilter: '^https?://([^/]+)\\.evm(?:/(.*))?$',
          resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
        },
      },
    ],
  });
});

// ── Message handler ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'LOAD') {
    handleLoad(msg.url, sendResponse);
    return true; // Keep channel open for async response
  }
  if (msg.type === 'SET_CHAIN') {
    chrome.storage.local.set({ preferredChainId: msg.chainId });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'GET_CHAINS') {
    getPreferredChainId().then(id => {
      sendResponse({ chains: CHAINS, preferredChainId: id });
    });
    return true;
  }
  if (msg.type === 'ETH_REQUEST') {
    handleEthRequest(msg.method, msg.params, sendResponse);
    return true;
  }
  return false;
});

// ── Ethereum wallet proxy ───────────────────────────────────────
// Finds a web page tab with window.ethereum (MetaMask) and executes
// the RPC request there via chrome.scripting.executeScript(MAIN world).

let walletTabId: number | null = null;

/** Cache of wallet state for event polling */
let lastAddress: string | null = null;
let lastChainId: string | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function findWalletTab(): Promise<number> {
  // Reuse cached tab if still valid
  if (walletTabId !== null) {
    try {
      const tab = await chrome.tabs.get(walletTabId);
      if (tab && tab.url && /^https?:/.test(tab.url)) return walletTabId;
    } catch { /* tab gone */ }
    walletTabId = null;
  }

  // Find any http/https tab (MetaMask injects into all of them)
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  if (tabs.length > 0 && tabs[0].id !== undefined) {
    walletTabId = tabs[0].id;
    return walletTabId;
  }

  // No web tab open — create one (MetaMask needs a real page)
  const newTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  // Navigate to a simple page so MetaMask injects
  await chrome.tabs.update(newTab.id!, { url: 'https://example.com' });
  // Wait a moment for MetaMask to inject
  await new Promise(r => setTimeout(r, 1500));
  walletTabId = newTab.id!;
  return walletTabId;
}

async function handleEthRequest(
  method: string,
  params: unknown[],
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    const tabId = await findWalletTab();

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      func: (m: string, p: unknown[]) => {
        const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
        if (!eth) throw new Error('No wallet extension detected. Install MetaMask or another EIP-1193 wallet.');
        return eth.request({ method: m, params: p });
      },
      args: [method, params || []],
    });

    const result = results?.[0]?.result;
    sendResponse({ result });

    // Start event polling after first successful request
    if (!pollInterval) startEventPolling();
  } catch (err) {
    console.error('[EVMFS] Wallet request failed:', err);
    sendResponse({ error: (err as Error).message });
  }
}

function startEventPolling(): void {
  if (pollInterval) return;

  pollInterval = setInterval(async () => {
    if (walletTabId === null) return;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: walletTabId },
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        func: () => {
          const eth = (window as unknown as { ethereum?: { selectedAddress?: string; chainId?: string } }).ethereum;
          if (!eth) return null;
          return { address: eth.selectedAddress || null, chainId: eth.chainId || null };
        },
        args: [],
      });

      const state = results?.[0]?.result as { address: string | null; chainId: string | null } | null;
      if (!state) return;

      if (state.address !== lastAddress) {
        lastAddress = state.address;
        chrome.runtime.sendMessage({
          type: 'ETH_EVENT',
          event: 'accountsChanged',
          data: state.address ? [state.address] : [],
        }).catch(() => { /* no listener */ });
      }
      if (state.chainId !== lastChainId) {
        lastChainId = state.chainId;
        chrome.runtime.sendMessage({
          type: 'ETH_EVENT',
          event: 'chainChanged',
          data: state.chainId,
        }).catch(() => { /* no listener */ });
      }
    } catch {
      // Tab might be closed — stop polling
      clearInterval(pollInterval!);
      pollInterval = null;
      walletTabId = null;
    }
  }, 2000);
}

async function handleLoad(
  url: string,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    const result = await loadEvmfs(url, (stage, percent) => {
      // Progress is sent via a separate port if the viewer uses one.
      // For simple message-based flow, progress is embedded in the final response.
      console.log(`[EVMFS] ${stage} (${percent}%)`);
    });
    sendResponse({ ok: true, result });
  } catch (err) {
    sendResponse({ ok: false, error: (err as Error).message });
  }
}

// ── Keep alive during long fetches ──────────────────────────────
// MV3 service workers can be killed after 30s of inactivity.
// Long-running port connections keep the SW alive.

/** Convert LoadResult to a port-safe format (ArrayBuffer → number[]) since
 *  Chrome extension port.postMessage uses JSON, not structured clone. */
function serializeResult(result: LoadResult): unknown {
  if (result.type === 'raw') {
    return {
      ...result,
      data: Array.from(new Uint8Array(result.data!)),
    };
  }
  return {
    ...result,
    files: result.files!.map(f => ({
      path: f.path,
      mime: f.mime,
      data: Array.from(new Uint8Array(f.data)),
    })),
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'evmfs-keepalive') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'LOAD') {
        try {
          const result = await loadEvmfs(msg.url, (stage, percent) => {
            port.postMessage({ type: 'PROGRESS', stage, percent });
          });
          port.postMessage({ type: 'RESULT', ok: true, result: serializeResult(result) });
        } catch (err) {
          port.postMessage({ type: 'RESULT', ok: false, error: (err as Error).message });
        }
      }
    });
  }
});

console.log('[EVMFS] Background service worker initialized');
