import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
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

// Walk balanced braces without interpreting braces inside JS strings or comments.
function expressionEnd(text: string, start: number) {
  let depth = 1;
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      if (end < 0) break;
      i = end;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

function maskMdx(markdown: string) {
  const syntax = /^(?:import|export)\b(?=[ \t{"'*(])[^\r\n]*|\\[\\{}]|\{/gm;
  if (!syntax.test(markdown)) return markdown;
  syntax.lastIndex = 0;
  // Use Markdown's own code boundaries, including nested and variable-length fences.
  const code = [...nodes(fromMarkdown(markdown))].filter(n => n.type === 'code' || n.type === 'inlineCode');
  let region = 0, copied = 0;
  const chunks: string[] = [];
  for (let hit; (hit = syntax.exec(markdown));) {
    while (region < code.length && code[region].position!.end.offset! <= hit.index) region++;
    if (region < code.length && code[region].position!.start.offset! <= hit.index) {
      syntax.lastIndex = code[region].position!.end.offset!;
      continue;
    }
    if (hit[0].startsWith('\\')) continue;
    if (hit[0] === '{') syntax.lastIndex = expressionEnd(markdown, hit.index);
    chunks.push(markdown.slice(copied, hit.index), markdown.slice(hit.index, syntax.lastIndex).replace(/[^\r\n]/g, ' '));
    copied = syntax.lastIndex;
  }
  return chunks.join('') + markdown.slice(copied);
}

export function links(markdown: string, site: URL, {mdx = false} = {}) {
  if (mdx) markdown = maskMdx(markdown);
  const root = fromMarkdown(markdown, {extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()]});
  const defs = new Map<string, string>();
  for (const n of nodes(root)) if (n.type === 'definition' && !defs.has(n.identifier)) defs.set(n.identifier, n.url);
  const found: {url: URL; line: number}[] = [];
  function add(raw: string | undefined, line: number) {
    if (!raw || !URL.canParse(raw)) return;
    const url = new URL(raw);
    if (url.origin === site.origin && !url.username && !url.password) found.push({url, line});
  }
  for (const n of nodes(root)) {
    if (!n.position) continue;
    const line = n.position.start.line;
    if (n.type === 'link') add(n.url, line);
    if (n.type === 'linkReference') add(defs.get(n.identifier), line);
    if (n.type !== 'html') continue;
    const fragment = parseFragment(n.value, {sourceCodeLocationInfo: true});
    const stack: DefaultTreeAdapterTypes.Node[] = [fragment];
    while (stack.length) {
      const el = stack.pop()!;
      if ('tagName' in el && el.tagName === 'a' && el.sourceCodeLocation)
        add(el.attrs.find(attr => attr.name === 'href')?.value, line + el.sourceCodeLocation.startLine - 1);
      if ('childNodes' in el) for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push(el.childNodes[i]);
    }
  }
  return found;
}

type Entry = {type: string; mode: string; path: string; sha: string; size: number};
export async function discover(site: URL, repo: string, prefix = '', get = fetch): Promise<Citation[]> {
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) throw new Error('Expected source repository owner/name');
  const headers = new Headers({accept: 'application/vnd.github+json', 'user-agent': 'citation-ci', 'x-github-api-version': '2022-11-28'});
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
  const markdown = /(?:\.md(?:own|x)?$|\.mkd$|\.markdown$|(?:^|\/)readme$)/i;
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
  const blobs = new Map<string, Promise<string>>();
  const cache = new Map<string, Promise<ReturnType<typeof links>>>();
  const pending = files.values();
  async function worker() {
    for (const f of pending) {
      const mdx = /\.mdx$/i.test(f.path);
      const key = f.sha + (mdx ? ':mdx' : ':md');
      let parsed = cache.get(key);
      if (!parsed) {
        let blob = blobs.get(f.sha);
        if (!blob) {
          blob = api(`git/blobs/${f.sha}`).then(b => {
            if (b.encoding !== 'base64' || typeof b.content !== 'string') throw new Error('Invalid GitHub blob');
            return Buffer.from(b.content,'base64').toString('utf8');
          });
          blobs.set(f.sha, blob);
        }
        parsed = blob.then(body => links(body, site, {mdx}));
        cache.set(key, parsed);
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
