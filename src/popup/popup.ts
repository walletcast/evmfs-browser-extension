export {}; // Ensure this file is treated as a module

const urlInput = document.getElementById('url-input') as HTMLInputElement;
const goBtn = document.getElementById('go-btn') as HTMLButtonElement;
const chainSelect = document.getElementById('chain-select') as HTMLSelectElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

// ── Initialize chain selector ───────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_CHAINS' }, (response) => {
  if (!response) return;

  // Add "Auto" option
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'Auto (try all)';
  chainSelect.appendChild(autoOpt);

  for (const chain of response.chains) {
    const opt = document.createElement('option');
    opt.value = String(chain.chainId);
    opt.textContent = `${chain.name} (${chain.chainId})`;
    chainSelect.appendChild(opt);
  }

  if (response.preferredChainId) {
    chainSelect.value = String(response.preferredChainId);
  }
});

// ── Chain selection ─────────────────────────────────────────────

chainSelect.addEventListener('change', () => {
  const val = chainSelect.value;
  const chainId = val ? parseInt(val, 10) : undefined;
  chrome.runtime.sendMessage({ type: 'SET_CHAIN', chainId });
});

// ── Go button ───────────────────────────────────────────────────

function go(): void {
  const input = urlInput.value.trim();
  if (!input) return;

  statusEl.textContent = 'Opening...';
  statusEl.className = 'status';

  // Open viewer page
  const url = chrome.runtime.getURL(`viewer.html?q=${encodeURIComponent(input)}`);
  chrome.tabs.create({ url });

  // Close popup after short delay
  setTimeout(() => window.close(), 200);
}

goBtn.addEventListener('click', go);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go();
});

// Focus input on open
urlInput.focus();
