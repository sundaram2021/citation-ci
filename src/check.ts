import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

export type Finding = { state: 'ok' | 'broken' | 'unknown'; detail: string };
export type Citation = { url: URL; count: number; engines: Set<string> };

export function site(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an HTTP(S) origin, e.g. https://docs.example.com');
  }
  return url;
}

function hasAnchor(html: string, id: string) {
  const stack: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  while (stack.length) {
    const node = stack.pop()!;
    if ('attrs' in node && node.attrs.some(attr => attr.value === id &&
        (attr.name === 'id' || (node.tagName === 'a' && attr.name === 'name')))) return true;
    if ('childNodes' in node) for (const child of node.childNodes) stack.push(child);
  }
  return false;
}

async function readHtml(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('HTML exceeds 2 MiB');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}

export async function inspect(citation: URL, origin: URL): Promise<Finding> {
  let current = new URL(origin);
  current.pathname = citation.pathname;
  current.search = citation.search;
  current.hash = citation.hash;
  const signal = AbortSignal.timeout(10000);
  const visited = new Set<string>();
  try {
    for (let hop = 0; hop <= 8; hop++) {
      if (visited.has(current.href)) return { state: 'broken', detail: 'redirect loop' };
      visited.add(current.href);
      const res = await fetch(current, { redirect: 'manual', signal });
      try {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) return { state: 'broken', detail: 'redirect without a destination' };
          const next = new URL(location, current);
          if (next.origin !== origin.origin || next.username || next.password)
            return { state: 'unknown', detail: 'redirect leaves configured origin' };
          if (!location.includes('#')) next.hash = current.hash;
          current = next;
          continue;
        }
        if ([404, 410].includes(res.status))
          return { state: 'broken', detail: 'HTTP ' + res.status };
        if (!res.ok) return { state: 'unknown', detail: 'HTTP ' + res.status };
        if (current.pathname === '/' && citation.pathname !== '/')
          return { state: 'broken', detail: 'redirects to homepage' };
        const landedPath = current.pathname.replace(/\/+$/, '');
        if (!current.hash && landedPath && citation.pathname.startsWith(landedPath + '/'))
          return { state: 'broken', detail: 'redirects to a parent section: ' + landedPath };
        if (current.hash) {
          if (!/^text\/html\b/i.test(res.headers.get('content-type') ?? '') ||
              current.hash.includes(':~:'))
            return { state: 'unknown', detail: 'unsupported fragment type' };
          const id = decodeURIComponent(current.hash.slice(1));
          if (id.toLowerCase() !== 'top' && !hasAnchor(await readHtml(res), id))
            return { state: 'broken', detail: 'missing HTML anchor' };
        }
        return { state: 'ok', detail: 'HTTP ' + res.status };
      } finally {
        if (!res.bodyUsed) await res.body?.cancel();
      }
    }
    return { state: 'unknown', detail: 'redirect limit exceeded' };
  } catch (error) {
    return { state: 'unknown', detail: error instanceof Error ? error.name + ': ' + error.message : 'request failed' };
  }
}

export function verdict(live: Finding, preview: Finding) {
  if (live.state === 'unknown' || preview.state === 'unknown') return 'inconclusive';
  if (preview.state === 'ok') return live.state === 'broken' ? 'fixed' : 'pass';
  return live.state === 'ok' ? 'regression' : 'pre-existing';
}
