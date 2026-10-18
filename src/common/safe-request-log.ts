type RequestPath = { originalUrl?: string; url?: string };

/** Query values and bearer tracking links must never enter logs or error paths. */
export function safeRequestPath(request: RequestPath): string {
  let path = (request.originalUrl || request.url || '/').split(/[?#]/, 1)[0];
  try { path = decodeURIComponent(path); } catch { /* Still mask the raw path. */ }
  return path.replace(/(\/tracking\/public\/)[^/?#]*/gi, '$1[redacted]')
    .replace(/[\r\n\x00-\x1f]/g, '').slice(0, 1000);
}

// Framework-generated errors may repeat the URL in their message/stack.
export function safeRequestError(value: string | undefined, request: RequestPath): string | undefined {
  if (!value) return value;
  let result = value;
  for (const url of [request.originalUrl, request.url]) {
    if (!url) continue;
    const variants = [url];
    try { variants.push(decodeURIComponent(url)); } catch { /* Invalid URL. */ }
    for (const variant of variants) {
      result = result.split(variant).join(safeRequestPath({ url: variant }));
      const token = variant.match(/\/tracking\/public\/([^/?#]+)/i)?.[1];
      if (token) result = result.split(token).join('[redacted]');
    }
  }
  return result;
}
