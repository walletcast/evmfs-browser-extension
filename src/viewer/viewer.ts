export {}; // Ensure this file is treated as a module

const loaderEl = document.getElementById('loader') as HTMLDivElement;
const progressEl = document.getElementById('progress') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const metaEl = document.getElementById('meta') as HTMLParagraphElement;
const contentEl = document.getElementById('content') as HTMLDivElement;
const rawContentEl = document.getElementById('raw-content') as HTMLDivElement;
const siteFrameEl = document.getElementById('site-frame') as HTMLIFrameElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const errorMsgEl = document.getElementById('error-message') as HTMLParagraphElement;
const retryBtn = document.getElementById('retry-btn') as HTMLButtonElement;

function setProgress(pct: number): void {
  progressEl.style.width = pct + '%';
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function showError(msg: string): void {
  loaderEl.classList.add('hidden');
  contentEl.classList.add('hidden');
  errorEl.classList.remove('hidden');
  errorMsgEl.textContent = msg;
}

function showContent(): void {
  loaderEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
}

// ── Get query from URL ──────────────────────────────────────────

function getQuery(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('q') || '';
}

// ── Send data to sandbox iframe for rendering ───────────────────
// The sandbox page has a relaxed CSP that allows blob: URLs and
// inline scripts, so it can render full SPA/Vite sites.

function sendToSandbox(result: { type: string; mime?: string; data?: unknown; files?: unknown[] }): void {
  const sandbox = siteFrameEl;

  function doSend(): void {
    if (result.type === 'raw') {
      sandbox.contentWindow!.postMessage(
        { type: 'RENDER', renderType: 'raw', data: result.data, mime: result.mime },
        '*',
      );
    } else {
      sandbox.contentWindow!.postMessage(
        { type: 'RENDER', renderType: 'site', files: result.files },
        '*',
      );
    }
  }

  // Listen for sandbox ready signal or render result
  window.addEventListener('message', function handler(event) {
    if (!event.data) return;
    if (event.data.type === 'SANDBOX_READY') {
      doSend();
    } else if (event.data.type === 'RENDER_OK') {
      window.removeEventListener('message', handler);
    } else if (event.data.type === 'RENDER_ERROR') {
      window.removeEventListener('message', handler);
      showError('Render error: ' + event.data.error);
    }
  });

  // The sandbox may already be loaded — try sending immediately too
  try {
    if (sandbox.contentWindow) doSend();
  } catch {
    // sandbox not ready yet, the SANDBOX_READY handler will fire
  }

  sandbox.classList.remove('hidden');
  rawContentEl.classList.add('hidden');
  showContent();
}

// ── Render raw non-site content directly in viewer ──────────────

function toArrayBuffer(v: unknown): ArrayBuffer {
  if (v instanceof ArrayBuffer) return v;
  if (v instanceof Uint8Array)
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (ArrayBuffer.isView(v)) {
    const view = v as DataView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(v)) {
    return new Uint8Array(v as number[]).buffer as ArrayBuffer;
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const len =
      typeof obj['byteLength'] === 'number'
        ? (obj['byteLength'] as number)
        : Object.keys(obj).filter(k => /^\d+$/.test(k)).length;
    if (len > 0) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = (obj[i] as number) || 0;
      return buf.buffer as ArrayBuffer;
    }
  }
  console.error('[EVMFS] toArrayBuffer: unexpected type', typeof v, v);
  throw new Error(`Cannot convert to ArrayBuffer (got ${typeof v})`);
}

function renderRawInline(rawData: unknown, mime: string, cid: string): void {
  const data = toArrayBuffer(rawData);

  // Non-HTML raw files can render directly in the viewer (no CSP issue)
  if (mime.startsWith('image/')) {
    const blob = new Blob([data], { type: mime });
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = 'EVMFS image ' + cid.slice(0, 12);
    rawContentEl.appendChild(img);
    showContent();
  } else if (
    mime.startsWith('text/') && mime !== 'text/html' ||
    mime === 'application/json'
  ) {
    const text = new TextDecoder().decode(data);
    const pre = document.createElement('pre');
    pre.textContent = text;
    rawContentEl.appendChild(pre);
    showContent();
  } else if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const blob = new Blob([data], { type: mime });
    const el = document.createElement(
      mime.startsWith('video/') ? 'video' : 'audio',
    ) as HTMLMediaElement;
    el.src = URL.createObjectURL(blob);
    el.controls = true;
    rawContentEl.appendChild(el);
    showContent();
  } else {
    // For HTML and binary files, delegate to sandbox
    return sendToSandbox({ type: 'raw', data: rawData, mime });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Ethereum wallet proxy bridge ────────────────────────────────
// Relays ETH_REQUEST from the sandbox iframe to the background SW,
// and ETH_RESPONSE / ETH_EVENT back to the sandbox.

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'ETH_REQUEST') return;

  const { id, method, params } = event.data;

  chrome.runtime.sendMessage(
    { type: 'ETH_REQUEST', id, method, params },
    (response) => {
      if (chrome.runtime.lastError) {
        siteFrameEl.contentWindow?.postMessage(
          { type: 'ETH_RESPONSE', id, method, error: chrome.runtime.lastError.message },
          '*',
        );
        return;
      }
      siteFrameEl.contentWindow?.postMessage(
        {
          type: 'ETH_RESPONSE',
          id,
          method,
          result: response?.result,
          error: response?.error,
        },
        '*',
      );
    },
  );
});

// Forward ETH_EVENT from background to sandbox
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ETH_EVENT') {
    siteFrameEl.contentWindow?.postMessage(
      { type: 'ETH_EVENT', event: msg.event, data: msg.data },
      '*',
    );
  }
});

// ── Load content ────────────────────────────────────────────────

async function load(): Promise<void> {
  const query = getQuery();
  if (!query) {
    showError('No EVMFS URL specified. Use the popup or omnibox to navigate.');
    return;
  }

  document.title = `EVMFS: ${query}`;
  setStatus(`Loading ${query}...`);

  const port = chrome.runtime.connect({ name: 'evmfs-keepalive' });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      setProgress(msg.percent);
      setStatus(msg.stage);
    } else if (msg.type === 'RESULT') {
      port.disconnect();
      if (!msg.ok) {
        showError(msg.error);
        return;
      }

      const result = msg.result;
      metaEl.textContent = `CID: ${result.cid.slice(0, 14)}... | Chain: ${result.chainName}`;

      if (result.type === 'raw') {
        renderRawInline(result.data, result.mime, result.cid);
      } else {
        // Sites always go to sandbox (needs relaxed CSP for blob: scripts)
        sendToSandbox(result);
      }
    }
  });

  port.postMessage({ type: 'LOAD', url: query });
}

// ── Retry ───────────────────────────────────────────────────────

retryBtn.addEventListener('click', () => {
  errorEl.classList.add('hidden');
  loaderEl.classList.remove('hidden');
  setProgress(0);
  load();
});

// ── Init ────────────────────────────────────────────────────────

load();
