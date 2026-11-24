# Citation CI

Catch a docs change that breaks a link someone already got from an AI answer. Citation CI compares the exact cited URL on production with the same path, query, and fragment on a deployment preview. The result appears in the GitHub check log and job summary.

A docs migration can send `/docs/auth#keys` to the homepage and still return HTTP 200. Citation CI shows the reviewer which destination changed and how many citation observations led there.

[Verification report with GitHub Actions logs](docs/verification.md)

## Try it in a minute

Requires Node.js 24 or later and npm. From a checkout:

```sh
npm ci
npm run demo
```

The demo starts two temporary local sites and uses one synthetic citation. On its first run the preview redirects the guide to the homepage. The second run corrects the redirect and preserves the section.

```text
[regression]  /docs/auth#keys  | live: HTTP 200  | preview: missing HTML anchor  | citations: 1 example
[pass]  /docs/auth#keys  | live: HTTP 200  | preview: HTTP 200  | citations: 1 example
```

## Check your preview

Save a CSV as `citations.csv`. Use absolute URLs on the origin you want to protect. The optional `engine` and `count` columns describe your observations. The default count is one.

```csv
url,engine,count
https://docs.example.com/sdk?version=2#authentication,ChatGPT,3
https://docs.example.com/quickstart,Perplexity,1
```

```sh
npm run check -- --production https://docs.example.com \
  --preview https://docs-pr-42.example.net --file citations.csv
```

A plain text file with one URL per line also works. Add `--json` for structured output. When redirecting stdout to a file, use `npm run --silent check -- ... --json` to omit npm's banner.

## Add the GitHub Action

Add the step below to your existing trusted deployment job **after the preview for the current commit is ready**. Replace `steps.deploy.outputs.url` with the URL output from your deployment step. Set the repository variable `DOCS_PRODUCTION_ORIGIN`.

```yaml
- name: Check AI citations on this preview
  uses: sundaram2021/citation-ci@main
  with:
    production: ${{ vars.DOCS_PRODUCTION_ORIGIN }}
    preview: ${{ steps.deploy.outputs.url }}
    file: citations.csv
```

Pin the action to a reviewed commit SHA for production use. Check out the repository containing `citations.csv` before this step. The action needs no GitHub write permissions. A failed step marks its job as failed. Configure that job as a required check to enforce it before merging.

Citations that differ only by fragment share one fetch per redirect hop and one parse of the final HTML per origin. Query strings remain distinct. The checker processes at most four documents at once on each origin.

## Read the result

| Result | Meaning |
| --- | --- |
| `pass` | The citation works on both sites. |
| `fixed` | A previously broken citation works on the preview. |
| `regression` | The live citation works and the preview fails a destination check. |
| `pre-existing` | Both destinations already fail a check. |
| `inconclusive` | At least one destination could not be evaluated reliably. |

Exit code **0** means the comparison completed without a new regression. **1** means at least one new regression. **2** means invalid input, an empty inventory, or an inconclusive comparison with no confirmed regression. The summary lists up to 100 findings and the job log contains all results. Query values are redacted from reported paths.

### What the checker can establish

- A 404, 410, redirect loop, or missing redirect destination breaks the citation.
- A deep link redirected to the homepage without a section is flagged. A redirect to a named homepage section must resolve to an existing anchor. A link without a fragment redirected to an ancestor section such as `/docs` is also flagged. This is a review heuristic for pages that may have lost their specific answer.
- HTML fragment checks use parsed, server-returned HTML. Redirects inherit the original fragment unless the destination supplies another. An explicitly cleared anchor is reported as broken. Client-rendered anchors can require review.
- Timeouts, access restrictions, server errors, cross-origin redirects, text fragments, and oversized HTML produce an inconclusive result. Use the final production hostname as the configured origin.
- Each pair checks URL health. A page that serves unrelated content with HTTP 200 at its original path can pass. AI ranking, answer accuracy, and future citations need separate measurement.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run demo
```

The test suite uses loopback HTTP fixtures. CI runs the composite action against two HTTP fixtures, verifies that removing the cited section fails the check, then restores the section and requires the check to pass.
