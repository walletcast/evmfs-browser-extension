/**
 * Sandbox page renderer.
 *
 * Runs inside a manifest-declared sandbox page with a relaxed CSP.
 * All assets are inlined as data URIs (no blob URLs — they fail
 * in sandbox pages because every null origin is unique).
 *
 * Rewriting uses syntax-aware parsers for JS imports and HTML
 * attributes instead of fragile generic regex matching.
 *
 * Communication with the parent viewer.html happens via postMessage.
 */
export {};

const siteFrameEl = document.getElementById('site-frame') as HTMLIFrameElement;
const listingEl = document.getElementById('listing') as HTMLPreElement;

// ── Data normalization ──────────────────────────────────────────

function toArrayBuffer(v: unknown): ArrayBuffer {
  if (v instanceof ArrayBuffer) return v;
  if (v instanceof Uint8Array)
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (ArrayBuffer.isView(v)) {
    const view = v as DataView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(v)) return new Uint8Array(v as number[]).buffer as ArrayBuffer;
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
  console.error('[EVMFS sandbox] toArrayBuffer: unexpected type', typeof v, v);
  throw new Error(`Cannot convert to ArrayBuffer (got ${typeof v})`);
}

// ── Path utilities ──────────────────────────────────────────────

function normPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

function resolvePath(from: string, rel: string): string {
  if (rel.startsWith('/')) return normPath(rel);
  if (!rel.startsWith('.')) return rel; // bare specifier — leave as-is
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const parts = (dir + rel).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

function isJsPath(path: string): boolean {
  return path.endsWith('.js') || path.endsWith('.mjs');
}

function isCssPath(path: string): boolean {
  return path.endsWith('.css');
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/javascript' ||
    mime === 'application/json'
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Base64 / data URI helpers ───────────────────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function toDataUri(data: ArrayBuffer, mime: string): string {
  return `data:${mime};base64,${arrayBufferToBase64(data)}`;
}

function textToDataUri(text: string, mime: string): string {
  return `data:${mime};base64,${btoa(unescape(encodeURIComponent(text)))}`;
}

// ── Syntax-aware rewriting ──────────────────────────────────────
// These replace the generic regex-based rewriteRefs with functions
// that understand JS import syntax and HTML attribute syntax.

/** Resolve an import path relative to the current file and look up its data URI. */
function resolveDataUri(
  importPath: string,
  filePath: string,
  dataUrls: Map<string, string>,
): string | undefined {
  if (importPath.startsWith('data:') || importPath.startsWith('http') || importPath.startsWith('blob:')) {
    return undefined;
  }
  const resolved = normPath(resolvePath(filePath, importPath));
  return dataUrls.get(resolved);
}

/** Rewrite JS import/export paths to data URIs.
 *  Handles minified Vite output: import{h}from"./vendor.js"
 *
 *  IMPORTANT: The `from` keyword must be preceded by a closing brace,
 *  identifier char, or whitespace to be an actual import/export clause.
 *  This avoids false positives like `{from:"value"}` or `.from("x")`. */
function rewriteJsImports(
  content: string,
  filePath: string,
  dataUrls: Map<string, string>,
): string {
  // import/export ... from "path"
  // Must be preceded by }, *, identifier char, or whitespace (not : or .)
  content = content.replace(
    /([}\w*\s])from\s*(["'])([^"']+?)\2/g,
    (match, pre: string, quote: string, importPath: string) => {
      const uri = resolveDataUri(importPath, filePath, dataUrls);
      return uri ? `${pre}from${quote}${uri}${quote}` : match;
    },
  );

  // import("path") — dynamic import
  content = content.replace(
    /\bimport\s*\(\s*(["'])([^"']+?)\1\s*\)/g,
    (match, quote: string, importPath: string) => {
      const uri = resolveDataUri(importPath, filePath, dataUrls);
      return uri ? `import(${quote}${uri}${quote})` : match;
    },
  );

  // import "path" / import"path" — side-effect import (minified has no space)
  content = content.replace(
    /\bimport\s*(["'])([^"']+?)\1/g,
    (match, quote: string, importPath: string) => {
      const uri = resolveDataUri(importPath, filePath, dataUrls);
      return uri ? `import${quote}${uri}${quote}` : match;
    },
  );

  return content;
}

/** Rewrite CSS url() references to data URIs. */
function rewriteCssUrls(
  content: string,
  filePath: string,
  dataUrls: Map<string, string>,
): string {
  return content.replace(
    /url\(\s*(["']?)([^)"']+?)\1\s*\)/g,
    (match, quote: string, urlPath: string) => {
      const uri = resolveDataUri(urlPath, filePath, dataUrls);
      return uri ? `url(${quote}${uri}${quote})` : match;
    },
  );
}

/** Rewrite HTML src/href attributes and inline style url() to data URIs. */
function rewriteHtmlRefs(
  html: string,
  dataUrls: Map<string, string>,
): string {
  // src="path", href="path", action="path"
  html = html.replace(
    /(src|href|action)\s*=\s*(["'])([^"']*?)\2/gi,
    (match, attr: string, quote: string, path: string) => {
      const norm = normPath(path);
      const uri = dataUrls.get(norm);
      return uri ? `${attr}=${quote}${uri}${quote}` : match;
    },
  );

  // Inline style url() references
  html = html.replace(
    /url\(\s*(["']?)([^)"']+?)\1\s*\)/g,
    (match, quote: string, urlPath: string) => {
      const norm = normPath(urlPath);
      const uri = dataUrls.get(norm);
      return uri ? `url(${quote}${uri}${quote})` : match;
    },
  );

  return html;
}

// ── Render site (data-URI inlining) ─────────────────────────────

function renderSite(
  rawFiles: Array<{ path: string; mime: string; data: unknown }>,
): void {
  const files = rawFiles.map(f => ({
    path: normPath(f.path),
    mime: f.mime,
    data: toArrayBuffer(f.data),
  }));

  const indexFile = files.find(f => f.path === 'index.html');
  if (!indexFile) {
    listingEl.style.display = 'block';
    listingEl.textContent =
      'Site files:\n' +
      files.map(f => `  ${f.path} (${formatSize(f.data.byteLength)})`).join('\n');
    return;
  }

  const fileMap = new Map<string, { data: ArrayBuffer; mime: string }>();
  for (const f of files) fileMap.set(f.path, { data: f.data, mime: f.mime });

  // Log all files in the ZIP for debugging
  console.log(`[EVMFS sandbox] All files in ZIP (${fileMap.size}):`);
  for (const [path, file] of fileMap) {
    console.log(`  ${path} (${file.mime}, ${formatSize(file.data.byteLength)})`);
  }

  const dataUrls = new Map<string, string>();

  // ── Phase 1: Binary files → data URIs ──
  for (const [path, file] of fileMap) {
    if (path === 'index.html') continue;
    if (!isTextMime(file.mime) && !isJsPath(path) && !isCssPath(path)) {
      dataUrls.set(path, toDataUri(file.data, file.mime));
    }
  }

  // ── Phase 2: CSS → rewrite url() to data URIs ──
  for (const [path, file] of fileMap) {
    if (file.mime === 'text/css' || isCssPath(path)) {
      let css = new TextDecoder().decode(file.data);
      css = rewriteCssUrls(css, path, dataUrls);
      dataUrls.set(path, textToDataUri(css, 'text/css'));
    }
  }

  // ── Phase 3: JS → topological sort, single-pass rewriting ──
  // Process each file EXACTLY ONCE, in dependency order (leaves first).
  // This avoids the exponential-growth problem of the iterative approach
  // where circular deps cause data URIs to embed each other recursively.
  const jsContents = new Map<string, string>();

  for (const [path, file] of fileMap) {
    if (
      file.mime === 'application/javascript' ||
      file.mime === 'text/javascript' ||
      isJsPath(path)
    ) {
      jsContents.set(path, new TextDecoder().decode(file.data));
    }
  }

  // Build dependency graph using syntax-aware import parsing
  // Use the same regex as rewriteJsImports to avoid false positives
  const jsDeps = new Map<string, string[]>();
  for (const [path, content] of jsContents) {
    const imports: string[] = [];
    // import/export ... from "path" (preceded by }, identifier, *, or whitespace)
    content.replace(/[}\w*\s]from\s*["']([^"']+)["']/g, (_m, p: string) => {
      if (!p.startsWith('http') && !p.startsWith('data:') && !p.startsWith('blob:')) {
        const resolved = normPath(resolvePath(path, p));
        if (jsContents.has(resolved)) imports.push(resolved);
      }
      return '';
    });
    // import("path") — dynamic import
    content.replace(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, (_m, p: string) => {
      if (!p.startsWith('http') && !p.startsWith('data:') && !p.startsWith('blob:')) {
        const resolved = normPath(resolvePath(path, p));
        if (jsContents.has(resolved)) imports.push(resolved);
      }
      return '';
    });
    // import"path" / import "path" — side-effect import (minified: no space)
    content.replace(/\bimport\s*["']([^"']+)["']/g, (_m, p: string) => {
      if (!p.startsWith('http') && !p.startsWith('data:') && !p.startsWith('blob:')) {
        const resolved = normPath(resolvePath(path, p));
        if (jsContents.has(resolved)) imports.push(resolved);
      }
      return '';
    });
    jsDeps.set(path, [...new Set(imports)]); // dedupe
    console.log(`[EVMFS sandbox] JS deps: ${path} → [${imports.join(', ')}]`);
  }

  // Topological sort with cycle detection
  const sorted: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function visit(path: string): void {
    if (visited.has(path)) return;
    if (inStack.has(path)) {
      console.warn(`[EVMFS sandbox] Circular dependency at: ${path} — skipping`);
      return;
    }
    inStack.add(path);
    for (const dep of jsDeps.get(path) || []) {
      visit(dep);
    }
    inStack.delete(path);
    visited.add(path);
    sorted.push(path);
  }

  for (const path of jsContents.keys()) visit(path);

  console.log(`[EVMFS sandbox] Phase 3: processing ${sorted.length} JS files in order: [${sorted.join(', ')}]`);

  // Process in sorted order (leaves first) — each file's deps already have data URIs
  for (const path of sorted) {
    const content = jsContents.get(path)!;
    const rewritten = rewriteJsImports(content, path, dataUrls);
    dataUrls.set(path, textToDataUri(rewritten, 'application/javascript'));
  }

  // ── Phase 4: Rewrite HTML ──
  let html = new TextDecoder().decode(indexFile.data);

  // Strip <link rel="modulepreload"> — not needed with data URIs
  html = html.replace(/<link[^>]*rel=["']modulepreload["'][^>]*\/?>/gi, '');

  // Find entry scripts and INLINE them (avoid data: URI base URL issues)
  // Replace <script ... src="/assets/index-xxx.js"> with inline <script>content</script>
  html = html.replace(
    /<script([^>]*)\ssrc\s*=\s*(["'])([^"']+?)\2([^>]*)><\/script>/gi,
    (match, pre: string, _q: string, src: string, post: string) => {
      const norm = normPath(src);
      // If we have a data URI for this script, inline its REWRITTEN content instead
      if (dataUrls.has(norm)) {
        // Get the rewritten content (not the data URI — we want inline)
        const rewritten = rewriteJsImports(jsContents.get(norm)!, norm, dataUrls);
        // Preserve type="module" etc. but remove src
        return `<script${pre}${post}>${rewritten}</script>`;
      }
      return match;
    },
  );

  html = rewriteHtmlRefs(html, dataUrls);

  // Inject in-memory localStorage/sessionStorage polyfill.
  // Sandbox pages have an opaque origin — accessing the real localStorage
  // getter throws SecurityError (even `typeof localStorage` throws because
  // it's a property getter, not an undeclared variable).
  const storagePoly = `<script>(function(){` +
    `function S(){this._d={}}` +
    `S.prototype={getItem:function(k){return this._d.hasOwnProperty(k)?this._d[k]:null},` +
    `setItem:function(k,v){this._d[k]=String(v)},removeItem:function(k){delete this._d[k]},` +
    `clear:function(){this._d={}},get length(){return Object.keys(this._d).length},` +
    `key:function(i){return Object.keys(this._d)[i]||null}};` +
    `var s=new S();` +
    `try{window.localStorage.setItem('_','1');window.localStorage.removeItem('_')}` +
    `catch(e){Object.defineProperty(window,'localStorage',{value:s,configurable:true,writable:true})}` +
    `try{window.sessionStorage.setItem('_','1');window.sessionStorage.removeItem('_')}` +
    `catch(e){Object.defineProperty(window,'sessionStorage',{value:new S(),configurable:true,writable:true})}` +
    `})()</script>`;

  // Inject EIP-1193 window.ethereum proxy.
  // Proxies all request() calls to the viewer page (parent) via postMessage.
  // The viewer relays to the background SW, which executes in a real web tab
  // where MetaMask is injected.
  const ethereumPoly = `<script>(function(){` +
    `var _id=0,_cbs={},_evts={};` +
    `var _addr=null,_chain=null,_connected=false;` +
    // EIP-1193 provider
    `var P={` +
    `isMetaMask:true,` +
    `isConnected:function(){return _connected},` +
    `get selectedAddress(){return _addr},` +
    `get chainId(){return _chain},` +
    // request() — core method
    `request:function(args){` +
    `var id=++_id;` +
    `return new Promise(function(resolve,reject){` +
    `_cbs[id]={resolve:resolve,reject:reject};` +
    `window.parent.postMessage({type:'ETH_REQUEST',id:id,method:args.method,params:args.params||[]},'*')` +
    `})},` +
    // on(event, handler)
    `on:function(ev,fn){if(!_evts[ev])_evts[ev]=[];_evts[ev].push(fn);return P},` +
    // removeListener
    `removeListener:function(ev,fn){` +
    `if(_evts[ev])_evts[ev]=_evts[ev].filter(function(f){return f!==fn});return P},` +
    // removeAllListeners (some dApps call this)
    `removeAllListeners:function(ev){if(ev)_evts[ev]=[];else _evts={};return P},` +
    // enable() — legacy
    `enable:function(){return P.request({method:'eth_requestAccounts'})},` +
    // send/sendAsync — legacy
    `send:function(m,p){if(typeof m==='string')return P.request({method:m,params:p});return P.request(m)},` +
    `sendAsync:function(payload,cb){P.request({method:payload.method,params:payload.params})` +
    `.then(function(r){cb(null,{id:payload.id,jsonrpc:'2.0',result:r})})` +
    `.catch(function(e){cb(e,null)})}` +
    `};` +
    // Listen for responses and events from the viewer
    `window.addEventListener('message',function(e){` +
    `if(!e.data)return;` +
    `if(e.data.type==='ETH_RESPONSE'&&_cbs[e.data.id]){` +
    `var cb=_cbs[e.data.id];delete _cbs[e.data.id];` +
    `if(e.data.error)cb.reject(new Error(e.data.error));` +
    `else{` +
    // Update cached state from successful responses
    `if(e.data.method==='eth_requestAccounts'||e.data.method==='eth_accounts'){` +
    `if(e.data.result&&e.data.result.length){_addr=e.data.result[0];_connected=true}}` +
    `if(e.data.method==='eth_chainId'){_chain=e.data.result}` +
    `cb.resolve(e.data.result)}}` +
    `if(e.data.type==='ETH_EVENT'){` +
    `var fns=_evts[e.data.event]||[];` +
    `if(e.data.event==='accountsChanged'&&e.data.data&&e.data.data.length)_addr=e.data.data[0];` +
    `if(e.data.event==='chainChanged')_chain=e.data.data;` +
    `fns.forEach(function(fn){try{fn(e.data.data)}catch(x){}})}` +
    `});` +
    // Expose globally
    `window.ethereum=P;` +
    // Dispatch EIP-6963 announceProvider event for modern dApps
    `window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:` +
    `Object.freeze({info:{uuid:'evmfs-proxy',name:'EVMFS Wallet Bridge',icon:'data:image/svg+xml,<svg/>',rdns:'app.evmfs.wallet'},provider:P})}));` +
    // Listen for EIP-6963 requestProvider events
    `window.addEventListener('eip6963:requestProvider',function(){` +
    `window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:` +
    `Object.freeze({info:{uuid:'evmfs-proxy',name:'EVMFS Wallet Bridge',icon:'data:image/svg+xml,<svg/>',rdns:'app.evmfs.wallet'},provider:P})}))});` +
    `})()</script>`;

  // Insert polyfills right after <head> (before any other scripts)
  html = html.replace(/<head([^>]*)>/i, `<head$1>${storagePoly}${ethereumPoly}`);

  console.log(`[EVMFS sandbox] Phase 4: HTML rewritten, ${dataUrls.size} data URIs total`);

  // Inject into sandbox document directly via document.write.
  siteFrameEl.style.display = 'none';
  document.open();
  document.write(html);
  document.close();
}

// ── Render raw file ─────────────────────────────────────────────

function renderRaw(rawData: unknown, mime: string): void {
  const data = toArrayBuffer(rawData);

  if (mime === 'text/html') {
    const html = new TextDecoder().decode(data);
    document.open();
    document.write(html);
    document.close();
  } else if (mime.startsWith('image/')) {
    const uri = toDataUri(data, mime);
    document.body.innerHTML = `<img src="${uri}" style="max-width:100%;height:auto">`;
  } else if (
    (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript')
  ) {
    const text = new TextDecoder().decode(data);
    listingEl.style.display = 'block';
    listingEl.textContent = text;
  } else if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const uri = toDataUri(data, mime);
    const tag = mime.startsWith('video/') ? 'video' : 'audio';
    document.body.innerHTML = `<${tag} src="${uri}" controls style="max-width:100%"></${tag}>`;
  } else {
    const uri = toDataUri(data, mime);
    document.body.innerHTML = `<a href="${uri}" download style="color:#818cf8;font-size:1.2em;padding:2em;display:block">Download file (${formatSize(data.byteLength)})</a>`;
  }
}

// ── Listen for messages from viewer ─────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'RENDER') return;

  try {
    if (msg.renderType === 'site') {
      renderSite(msg.files);
    } else {
      renderRaw(msg.data, msg.mime);
    }
    window.parent.postMessage({ type: 'RENDER_OK' }, '*');
  } catch (err) {
    console.error('[EVMFS sandbox] render error:', err);
    window.parent.postMessage(
      { type: 'RENDER_ERROR', error: (err as Error).message },
      '*',
    );
  }
});

// Signal readiness
window.parent.postMessage({ type: 'SANDBOX_READY' }, '*');
