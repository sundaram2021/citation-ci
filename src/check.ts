import { MIMEType } from 'node:util';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

export type Finding = { state: 'ok' | 'broken' | 'unknown'; detail: string };
export type Source = { repo: string; commit: string; path: string; line: number; permalink: string };
export type Citation = { url: URL; count: number; engines: Set<string>; sources?: Source[] };

export function site(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an HTTP(S) origin, e.g. https://docs.example.com');
  }
  return url;
}

function anchorIds(html: string) {
  const ids = new Set<string>();
  const stack: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  while (stack.length) {
    const node = stack.pop()!;
    if ('attrs' in node) {
      for (const attr of node.attrs) {
        if (attr.name === 'id' || (node.tagName === 'a' && attr.name === 'name')) ids.add(attr.value);
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push(child);
  }
  return ids;
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
    const charset = new MIMEType(res.headers.get('content-type')!).params.get('charset') ?? 'utf-8';
    return new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel();
  }
}

function unknown(error: unknown): Finding {
  return { state: 'unknown', detail: error instanceof Error ? error.message : 'request failed' };
}

export type CheckPolicy = {
  parentMoves?: ReadonlyMap<string, string>;
  errorPageMarker?: string;
};

// All citations in a group share the exact document URL, including its query.
export async function inspectDocument(citations: URL[], origin: URL, policy: CheckPolicy = {}): Promise<Finding[]> {
  const source = citations[0];
  let current = new URL(origin);
  current.pathname = source.pathname;
  current.search = source.search;
  let overrideHash: string | undefined;
  let homepageSectionTargeted = false;
  const signal = AbortSignal.timeout(10000);
  const visited = new Set<string>();
  const all = (state: Finding['state'], detail: string) => citations.map(() => ({ state, detail }));
  try {
    for (let hop = 0; hop <= 8; hop++) {
      if (visited.has(current.href)) return all('broken', 'redirect loop');
      visited.add(current.href);
      const res = await fetch(current, { redirect: 'manual', signal });
      try {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) return all('broken', 'redirect without a destination');
          const next = new URL(location, current);
          if (next.origin !== origin.origin || next.username || next.password)
            return all('unknown', 'redirect leaves configured origin');
          if (next.pathname === '/' && current.pathname !== '/') homepageSectionTargeted = Boolean(next.hash);
          if (location.includes('#')) overrideHash = next.hash;
          next.hash = '';
          current = next;
          continue;
        }
        if ([204, 205, 404, 410].includes(res.status)) return all('broken', 'HTTP ' + res.status);
        if (!res.ok) return all('unknown', 'HTTP ' + res.status);
        const landedPath = current.pathname.replace(/\/+$/, '');
        const citedPath = source.pathname.replace(/\/+$/, '');
        if (current.pathname === '/' && source.pathname !== '/' && !(homepageSectionTargeted && overrideHash))
          return all('broken', 'redirects to homepage');
        const acceptedParent = policy.parentMoves?.get(source.pathname + source.search) === current.pathname + current.search;
        const html = /^text\/html(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '');
        let ids: Set<string> | undefined;
        let htmlError: Finding | undefined;
        const hashes = citations.map(url => overrideHash ?? url.hash);
        const needsIds = hashes.some(hash => hash && hash.toLowerCase() !== '#top' && !hash.includes(':~:'));
        if (html && (needsIds || policy.errorPageMarker)) {
          try {
            const body = await readHtml(res);
            if (policy.errorPageMarker && body.includes(policy.errorPageMarker))
              return all('broken', 'matched configured error page marker');
            if (needsIds) ids = anchorIds(body);
          } catch (error) {
            if (policy.errorPageMarker) throw error;
            htmlError = unknown(error);
          }
        }
        return citations.map((citation, i): Finding => {
          const hash = hashes[i];
          if (!hash) {
            if (citation.hash) return {state: 'broken', detail: 'redirect discards cited anchor'};
            if (!acceptedParent && landedPath && citedPath.startsWith(landedPath + '/'))
              return {state: 'broken', detail: 'redirects to a parent section: ' + landedPath};
          } else {
            if (!html || hash.includes(':~:')) return {state: 'unknown', detail: 'unsupported fragment type'};
            let id: string;
            try { id = decodeURIComponent(hash.slice(1)); } catch { return {state: 'unknown', detail: 'invalid encoded fragment'}; }
            if (id.toLowerCase() !== 'top') {
              if (htmlError) return htmlError;
              if (!ids?.has(id)) return {state: 'broken', detail: 'missing HTML anchor'};
            }
          }
          return {state: 'ok', detail: 'HTTP ' + res.status};
        });
      } finally {
        if (!res.bodyUsed) await res.body?.cancel();
      }
    }
    return all('unknown', 'redirect limit exceeded');
  } catch (error) {
    return citations.map(() => unknown(error));
  }
}

export async function inspect(citation: URL, origin: URL): Promise<Finding> {
  return (await inspectDocument([citation], origin))[0];
}

export function verdict(live: Finding, preview: Finding) {
  if (live.state === 'unknown' || preview.state === 'unknown') return 'inconclusive';
  if (preview.state === 'ok') return live.state === 'broken' ? 'fixed' : 'pass';
  return live.state === 'ok' ? 'regression' : 'pre-existing';
}
