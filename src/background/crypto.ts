/** Extract a pure ArrayBuffer from a Uint8Array */
function buf(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/** Verify CID using rolling SHA-256: h1=SHA256(c1), h2=SHA256(h1||c2), ... */
export async function verifyCID(chunks: Uint8Array[], expectedCid: string): Promise<boolean> {
  if (chunks.length === 0) return false;

  let h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(chunks[0])));
  for (let i = 1; i < chunks.length; i++) {
    const joined = new Uint8Array(h.length + chunks[i].length);
    joined.set(h);
    joined.set(chunks[i], h.length);
    h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(joined)));
  }
  const computed =
    '0x' +
    Array.from(h)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  return computed.toLowerCase() === expectedCid.toLowerCase();
}
