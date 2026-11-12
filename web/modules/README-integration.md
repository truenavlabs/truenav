# Depth modules for the shell

TrueNav Labs. These files are the Phase B depth layer. They do not mount themselves. Import them from the app shell and pass data as props. Nothing here writes to a NEAR account.

Paths:

- `web/data/demo/funds.demo.json` is the generated fund detail. Rebuild with `node web/data/demo/generate.mjs`.
- `web/data/demo/cashflow-funds.json` is the same four off-chain funds, alone.
- `web/data/feeds/feeds.mjs` is the browser-direct allowlist.
- `web/public/feeds/snapshot.json` is the committed fallback. Rebuild with `node web/scripts/snapshot-feeds.mjs`.
- `web/modules/terminal.css` is the dark terminal skin. Scope it under `.tn-root` or copy the variables into the shell.

## Mount map

| Component | Suggested route | Props |
| --- | --- | --- |
| `MarketTicker` | top of the app | `items` from `tickerItems(feeds)` in `web/data/feeds/view.mjs` |
| `MarketsPanels` | `/markets` | `model` from `marketsModel(feeds)`, plus the `feeds` map for chips |
| `NavHistoryChart` | fund Overview | `points` = `fund.nav_history` |
| `ExposurePanel` | fund Exposure | `exposures`, `concentration` = `fund.why_score.concentration` |
| `CashFlowPanel` | fund Cash flows | `cashFlows`. For Ashgrove, Larkspur, Kestrel and Linden Court also pass `claimedVsSettled` |
| `StressPanel` | fund Stress | `scenarios` = `fund.stress_scenarios` |
| `LoanBook` | fund Loan book | `loans`, `lens` `"public"` or `"data_room"`, `onOpen(loan)` |
| `LoanDetail` | `/loans/:hash` | `loan`, `lens`. M-IN-03 carries `data_room.checks` |
| `InvestorView` | investor home | `funds`, optional `alerts` as `{ id, text }` |
| `ManagerView` | `/manager` | `fund` (Harbor or Meridian) |
| `AuditorView` | auditor home | `funds` |
| `ReportBundle` | `/reports/:id` | `fund`, optional prebuilt `bundle`, `readAt` |

Import from `web/modules/index.mjs`. The components call `react` `createElement`. They do not use JSX, so a JSX transform is not required for these files.

## Data the shell should pass

On-chain funds in `funds.demo.json` carry `anchors`. Before showing the data room, call `anchorsMatch(fund.anchors, live)` from `web/data/demo/model.mjs`. `live` is `{ score, true_val_cents, headline_cents, policy_nav_cents, loan_hashes }` from `get_latest_certificate` and `nft_tokens_for_owner`. If it returns `ok: false`, pass `outOfSync` (the returned `reason`) into the fund panels and keep `LoanBook` on the public lens. Do not fill a failed chain read from this file and then call it live.

`anchors.certificate` is the engine pin (`certify/testnet.mjs` checks Harbor `raw_x100` 9917 and Meridian 4284). It is tagged recorded until that live read matches.

`pledged_at_ms` is null on purpose. Read it from `nft_token`.

Market feeds:

```js
import { fetchFeed, presentFeed, startPoll } from "./data/feeds/feeds.mjs";
```

`fetchFeed(id)` throws on an id that is not in the allowlist. Poll with `startPoll`. Prices and network stay at 120 seconds or slower. Rates and FX stay at one hour or slower. Pass `hidden: () => document.hidden` so a background tab does not poll. On failure, `presentFeed({ id, live, snapshot })` keeps the snapshot value and sets `chip: "snapshot"`. If both fail, `value` is null. Do not substitute zero.

Load the snapshot with `fetch("/feeds/snapshot.json")`. CoinGecko rows include `attribution: "Data provided by CoinGecko"`. Show that next to every CoinGecko figure. External numbers are context only.

`defillama-pool-chart` needs a pool uuid from the T-bill snapshot (`value[].pool`). Any other string is refused.

## Report

`buildReportBundle` in `web/modules/report.mjs` returns the JSON file. `ReportBundle` renders the print sheet. Wire "Print" to `window.print()`. The print CSS is the `@media print` block in `terminal.css`.

## Checks

`node --test web/data/demo/consistency.test.mjs web/data/feeds/feeds.test.mjs web/modules/render.test.mjs`

The demo test asserts Harbor's 11 open loans, carrying value `$9,950,000`, TrueVal `$9,665,110`, and Meridian TrueVal `$3,092,970` from 4 loans with M-IN-03 excluded. Feed tests mock `fetch` and do not touch the network.

## Not in this folder

No wallet, no assist API, no `/api/feeds` function, no new npm dependency. Chain access stays in the shell's `web/chain.mjs` and must remain view calls to `registry.tnlab-368aa2.testnet`.
