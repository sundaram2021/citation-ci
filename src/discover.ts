import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import type { RootContent, Root } from 'mdast';
import type { Citation } from './check.ts';

function* nodes(root: Root): Generator<RootContent> {
  const stack: RootContent[] = [...root.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
}

export function links(markdown: string, site: URL) {
  const root = fromMarkdown(markdown, {extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()]});
  const defs = new Map<string, string>();
  for (const n of nodes(root)) if (n.type === 'definition' && !defs.has(n.identifier)) defs.set(n.identifier, n.url);
  const found: {url: URL; line: number}[] = [];
  for (const n of nodes(root)) {
    const raw = n.type === 'link' ? n.url : n.type === 'linkReference' ? defs.get(n.identifier) : undefined;
    if (!raw || !URL.canParse(raw)) continue;
    const url = new URL(raw);
    if (url.origin === site.origin && !url.username && !url.password && n.position)
      found.push({url, line: n.position.start.line});
  }
  return found;
}

type Entry = {type: string; mode: string; path: string; sha: string; size: number};
export async function discover(site: URL, repo: string, prefix = '', get = fetch): Promise<Citation[]> {
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) throw new Error('Expected source repository owner/name');
  const headers = new Headers({accept: 'application/vnd.github+json'});
  if (process.env.GH_SOURCE_TOKEN) headers.set('authorization', `Bearer ${process.env.GH_SOURCE_TOKEN}`);
  async function api(path: string) {
    const res = await get(`https://api.github.com/repos/${repo}/${path}`, {headers, redirect:'error', signal: AbortSignal.timeout(20000)});
    if (!res.ok) throw new Error(`GitHub source request returned HTTP ${res.status} (${repo}); check repository access and API quota`);
    return res.json();
  }
  // One trailing slash is valid for directories. An empty prefix selects the root.
  if (prefix.startsWith('/') || prefix.includes('//')) throw new Error('Expected a repository-relative source path');
  prefix = prefix.replace(/\/$/, '');
  const parts = prefix ? prefix.split('/') : [];
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Expected a repository-relative source path');
  // Resolve the default branch once. All subsequent reads use immutable object IDs.
  const commit = await api('commits/HEAD');
  if (![commit.sha, commit.commit?.tree?.sha].every(s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s))) throw new Error('Invalid GitHub commit');
  const markdown = /(?:\.md(?:own)?$|\.markdown$|(?:^|\/)readme$)/i;
  // Walk one tree per path component; a scoped scan never lists the rest of the repository.
  let treeSha = commit.commit.tree.sha;
  let files: Entry[] | undefined;
  for (const [i,part] of parts.entries()) {
    const dir = await api(`git/trees/${treeSha}`);
    const match = dir.tree?.find((e: Entry)=>e.path===part);
    if (!match || dir.truncated) throw new Error(`Cannot resolve source path ${prefix}`);
    if (match.type==='tree') treeSha = match.sha;
    else if (match.type==='blob' && match.mode.startsWith('100') && i===parts.length-1 && markdown.test(prefix)) files=[{...match,path:prefix}];
    else throw new Error(`Expected a Markdown file or directory: ${prefix}`);
  }
  if (!files) {
    const tree = await api(`git/trees/${treeSha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete GitHub tree; narrow --source-path or use --file');
    files = (tree.tree as Entry[]).filter(e => e.type === 'blob' && e.mode.startsWith('100') && markdown.test(e.path))
      .map(e=>({...e,path:prefix ? `${prefix}/${e.path}` : e.path}));
  }
  if (files.length > 300 || files.some(f => f.size > 1024*1024) || files.reduce((n,f)=>n+f.size,0)>16*1024*1024)
    throw new Error('Markdown scan exceeds budget; narrow --source-path or use --file');
  const entries = new Map<string,Citation>();
  const cache = new Map<string, Promise<ReturnType<typeof links>>>();
  const pending = files.values();
  async function worker() {
    for (const f of pending) {
      let parsed = cache.get(f.sha);
      if (!parsed) {
        parsed = api(`git/blobs/${f.sha}`).then(b => {
          if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('Invalid GitHub blob');
          return links(Buffer.from(b.content,'base64').toString('utf8'),site);
        });
        cache.set(f.sha,parsed);
      }
      for (const {url,line} of await parsed) {
        const item = entries.get(url.href) ?? {url,count:0,engines:new Set<string>(),sources:[]};
        item.count++;
        item.sources!.push({repo,commit:commit.sha,path:f.path,line,
          permalink:`https://github.com/${repo}/blob/${commit.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}#L${line}`});
        entries.set(url.href,item);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(files.length,4)},worker));
  if (!entries.size) throw new Error(`No published Markdown links matched ${site.origin} in ${repo} at ${commit.sha}`);
  for (const item of entries.values()) item.sources!.sort((a,b)=>a.path.localeCompare(b.path)||a.line-b.line);
  return [...entries.values()].sort((a,b)=>b.count-a.count||a.url.href.localeCompare(b.url.href));
}
