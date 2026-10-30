# NSE stock research agent

TypeScript service built around [`freetier-deepagent-framework`](https://github.com/RY0502/freetier-deepagent-framework) (LangGraph / Deep Agents). An unauthenticated HTTP request starts a disk-backed job that screens NSE equity bhavcopies, researches qualifying companies on live pages, and appends only final display data to Supabase.

**Research only, not trading or financial advice.** Profit categories are qualitative outlooks for the **next trading week**, not numerical probabilities or guarantees of returns.

## Setup

Requires Node.js 22+ and npm.

```sh
npm ci
cp .env.example .env
```

Populate `.env` locally. Never commit credentials. Use the Supabase **service-role** key server-side only. Use a **dedicated Neon database** for framework state/checkpoints: each accepted run clears framework state after acquiring the run lock, before downloading or researching anything. Supabase is separate and is not reset. The pinned framework requires all five listed main-provider keys plus Tavily and Neon, even if an earlier provider handles the entire run. See its repository for optional sub-agent provider configuration and model overrides.

```sh
npm run db:setup
```

Apply **`supabase/migrations/001_profit_probability.sql`**, then **`supabase/migrations/002_report_url.sql`** in the Supabase SQL editor or your migration tool. They add nullable `profit_probability` (`low`, `medium`, `high` or null) and `report_url` to your existing `top_gainers` and `top_losers` tables. Both are repeatable and preserve existing columns, IDs and data; legacy report URLs remain null. They create no tables, functions or indexes, and change no access policies. The existing tables must already exist. Configure RLS for your consuming application and allow the server's service-role key to select/count, delete and insert.

### Cloudflare report hosting

Reports use **Cloudflare Workers KV + a Worker** only: no R2, Convex, or external file storage. Each small, responsive HTML report is stored under `stock-reports/<run_id>/<gainers|losers>/<stockcode>.html`, served through the Worker, and its public URL is written to Supabase as before.

Deploy the Worker once from this project:

```sh
npx wrangler login
npx wrangler kv namespace create REPORTS --config cloudflare/wrangler.jsonc
# Copy the returned namespace ID into cloudflare/wrangler.jsonc.
npx wrangler secret put REPORT_UPLOAD_TOKEN --config cloudflare/wrangler.jsonc
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

Choose a random upload token of at least 32 characters. Set the same token in the service's `.env`, alongside the deployed Worker's HTTPS origin (a `workers.dev` address or Worker custom domain):

```dotenv
CLOUDFLARE_REPORT_URL=https://stock-reports.YOUR_SUBDOMAIN.workers.dev
CLOUDFLARE_REPORT_UPLOAD_TOKEN=
```

The URL must be an HTTPS origin without a path, credentials, query or fragment. The runtime only needs the Worker URL and upload token, not Cloudflare account credentials. Neither credential nor configuration secrets are embedded in reports. `wrangler` uses your login (or a deployment-only Cloudflare API token). Use a dedicated namespace for this application.

```sh
npm run reports:setup
```

This verifies the authenticated Worker health endpoint, KV binding, and five-day retention contract without changing Cloudflare resources. Startup performs the same check and fails explicitly on configuration or connectivity errors. Uploads require the secret; viewing a report is public. Do not share the upload token with your consuming app.

**Five-day expiry and cleanup:** each upload sets KV's native absolute expiration to five days after report creation. Cloudflare automatically removes expired entries, independently of research runs or server uptime; no cron, listing, or manual deletion is required. The Worker also checks expiry metadata on every read, including edge-cache hits, so a lingering cached copy cannot extend hosted access. Expired URLs return 404 or 410. Previously downloaded files or pages already open in an app cannot be recalled.

The Worker explicitly caches HTML using the Cache API, with browser/edge TTLs capped at 300 seconds and shortened near expiry. No HTML Cache Rule is required. Do not add a Cache Everything, minimum-TTL, or serve-stale override in front of the Worker that bypasses these checks. KV is eventually consistent: newly uploaded reports can take about 60 seconds (occasionally longer) to become visible in another region. Upload failure still blocks Supabase publication; a successful upload is not a guarantee of immediate global visibility. Keep deployment clocks synchronized: uploads reject creation timestamps more than five minutes away from Worker time.

Existing R2 report URLs are not migrated. If you previously deployed R2, leave its five-day lifecycle rule enabled until those reports expire, then remove the unused bucket/configuration yourself. No new reports use R2.

```sh
npm run build
npm start
# or: npm run dev
# For HTTP server: npm run server (or npm run dev:server)
```

### Freestyle VM lifecycle & pause

Every canonical agent invocation first runs Neon framework-state cleanup, validates the pause configuration, and runs the market agent. Whether the run succeeds, skips, or throws an error, it then sends one bounded GET to:
`${PAUSE_BASE_URL}/pause/vm?machine=${MACHINE_NO}`

The framework revision is pinned in `package.json`; transitive resolutions are recorded in `package-lock.json`. The upstream repository ships its compiled library.

## HTTP API

The server binds to `127.0.0.1:3000` by default. **There is deliberately no authentication**, per the requested design. Anyone able to reach it can clear Neon framework state, consume research quotas, append results and prune history. Keep it on a trusted network; exposing `HOST=0.0.0.0` publicly is unsafe.

```sh
curl -X POST http://127.0.0.1:3000/runs \
  -H 'Content-Type: application/json' \
  -d '{}'

# Optional historical screening date:
curl -X POST http://127.0.0.1:3000/runs \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-26"}'

curl http://127.0.0.1:3000/runs/REPLACE_WITH_RETURNED_UUID
curl http://127.0.0.1:3000/health
```

`POST /runs` returns `202` with an ID and status URL; it does not wait for research. Omitting the date means today's date in Asia/Kolkata. Invalid/future dates return `400`; overlapping runs return `409`. Status progresses through `queued`, `running` (including a `reporting` phase), `publishing`, and `completed`, `skipped` or `failed`. The final record retains compact stock outcomes, reasoning, diagnostics, background-cache provenance and report URL/cleanup time, but removes full intermediate research results. An empty shortlist inserts no rows but still participates in the table's retention check; a **skipped** run performs no Supabase operations at all, including retention deletes.

If the requested day's archive returns **404**, the run is **skipped**, not failed. This covers unavailable weekend/holiday files as well as a daily file not published yet. No earlier date is substituted, no research is performed, and Supabase remains unchanged. The status includes `skippedReason` and `missingDates`; availability alone does not establish that a date was a holiday. Run again after publication if necessary. Access errors, rate limits, timeouts and malformed archives still fail explicitly. An older screening date still receives **current research** and a next-trading-week outlook relative to research time, not historical fundamentals or a historical prediction; this is not a backtesting service.

## Screening configuration

The seven settings below are read for **each new run** and saved in its status record. Update `.env` before triggering another run; screening changes do not require restarting the service. Values in `.env` take precedence over process environment values for these screening settings only. Other service/provider settings remain startup configuration.

```dotenv
LOOKBACK_DAYS=30
GAINERS_INCREASE_RS=100
LOSERS_DECREASE_RS=100
GAINERS_MIN_PRICE=200
GAINERS_MAX_PRICE=2000
LOSERS_MIN_PRICE=200
LOSERS_MAX_PRICE=1500
```

`LOOKBACK_DAYS` must be a positive safe integer in calendar days; it also determines the background-research reuse window (`LOOKBACK_DAYS / 2`, default 15 days). Amounts must be positive, finite and have at most two decimal places. Each minimum must not exceed its maximum. Invalid settings fail explicitly. A running job keeps its initial settings even if `.env` changes halfway through it.

**Only gainers are active.** Loser screening/research/publication code and settings are retained, but the `'losers'` entry in `ACTIVE_GROUPS` in `src/screening.ts` is commented out. No loser research is run and `top_losers` is not counted, pruned or written.

## Screening rules

1. Download the NSE cash-market UDiFF ZIP/CSV for the requested date. Dates before 2024-07-08 use the legacy equity archive convention. Validate headers, trading dates, numeric fields, OHLC and ISIN identity. Keep traded `EQ` stock rows, not other series/instrument types or zero-volume rows (which can carry stale closes and zero HIGH/LOW).
2. Filter the requested day's **closing price** using the active group's inclusive configured range: by default ₹200–₹2,000 for gainers. Save the reduced universe and only carry these ISINs into history processing. The retained loser range defaults to ₹200–₹1,500 but is inactive. Raw daily CSVs remain intact so a future run can use different settings.
3. Target the requested date minus `LOOKBACK_DAYS` calendar days (default 30, not a calendar month). If absent, move **forward** to the first available historical bhavcopy on or after that date, strictly before the requested day. Record its actual `baselineDate` in job status and candidates. If no historical file exists in that interval, skip the run without research or Supabase operations; never compare the current day against itself.
4. Gainers: `latest HIGH − baseline HIGH ≥ GAINERS_INCREASE_RS`. The retained, paused loser formula is `latest LOW − baseline LOW ≤ −LOSERS_DECREASE_RS`. There is **no secondary threshold/filler pass**. Percentage change uses the corresponding baseline HIGH or LOW. These are endpoint comparisons, not the greatest excursion during the configured period.
5. Load intervening daily files for volume, turnover and close-to-close volatility. Latest volume is compared with the mean of earlier observations, excluding the current day. Match history by ISIN, allowing ticker renames. Companies without baseline history are excluded.
6. **Before research**, sort gainers by rupee increase over the configured period descending. Keep at most **25**, with symbol/ISIN tie-breakers. Only those stocks are researched. Preserve this membership and order after research; risk scores and profit categories never rerank or remove stocks. If fewer than 25 meet the configured screen, publish fewer without fillers. The paused loser path uses the largest rupee fall first (most negative change). Percentage movement is still calculated and published, but does not choose or order the shortlist.

Historical NSE `404` dates are omitted and explicitly recorded; they are **not claimed to be verified holidays**. Calculations use only available observations, without inventing zero-volume days for gaps. Weekends are probed too because special sessions can occur. Missing responses do not consume the 31-file successful-download budget. Access denial (`403`), rate limits, timeouts, malformed/corrupt archives, and schema drift fail the run rather than masquerading as holidays. There is no anti-bot bypass. NSE may restrict downloads from your deployment network.

At most **31 successfully downloaded bhavcopy files** are allowed per run. Cache hits and `404` responses do not consume this budget. Increasing `LOOKBACK_DAYS` does not raise this cap or extend the two-calendar-month raw-file retention: longer windows may require already-cached history, or fail explicitly rather than exceed the cap or silently shorten the window.

## Live research and profit categories

Each shortlisted entry is evaluated through `DeepAgentRunner`, retaining the framework's LLM provider rotation and Neon checkpoints. **Dated NSE files supply numerical valuation context; Tavily supplies company/sector news and qualitative business risks.** Use `tavily_search` with `topic="news", days=1`, widening to at most seven days for sparse coverage. Callback auditing captures individual Tavily result URLs and their content/raw content, not generated answers. A structured submission tool validates types and stock identity; free-form prose cannot directly become a prediction. TODO tools are removed from root model requests, and an accepted assessment completes without another model request.

### NSE daily valuation and event files

After screening, download the reports for the actual bhavcopy trading dates in the configured comparison window, once per date for the selected batch:

| Source | Data used |
|---|---|
| `https://nsearchives.nseindia.com/content/equities/peDetail/PE_DDMMYY.csv` | `SYMBOL P/E` and the separate `ADJUSTED P/E` |
| `https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PRDDMMYY.zip` → `mcapDDMMYYYY.csv` | EQ market capitalisation, converted from INR to INR crore by dividing by 10,000,000 |
| Same PR ZIP → `bcDDMMYYYY.csv` | EQ corporate-action/book-closure purposes and ex/record/book dates |

Match each report's symbol to **that date's bhavcopy ISIN**, not blindly to today's ticker. The model receives the P/E history, current-date P/E/adjusted P/E and market cap, plus known corporate-action notices within the screen window or the next ten calendar days. It considers these with volume, liquidity, volatility, news and downside risks when forecasting the next trading week. P/E changes alone do not measure earnings growth; a low P/E is not a guaranteed buy signal. SYMBOL P/E is primary; ADJUSTED P/E is retained separately, never silently substituted.

NSE P/E is not available for every stock. Blank/NA/nonpositive ratios and NSE's `Infinity`/`NaN` entries remain unknown, not zero. Missing stock entries or report `404`s are recorded without excluding selected stocks. Other HTTP errors, malformed archives, unsafe numbers or date/schema mismatches fail explicitly.

When an analysis-date P/E, adjusted P/E or market cap is unavailable, the agent uses that metric's **latest valid older observation within the run's analysis window** as explicitly dated historical context. `candidate.nse` keeps current values separate from its `historical` fallbacks, each of which includes `asOf` and the original NSE source. Different metrics may come from different dates; adjusted P/E never substitutes for SYMBOL P/E. Valid current observations always take priority. No extra NSE files are downloaded beyond the normal window to fill these gaps. This applies to fresh research and cache-hit refreshes; reports label historical market-cap context with its actual date and do not display historical P/E. Missing-current-metric logs include `historicalDates` when fallbacks exist. Corporate-action notices already retain their historical report and event dates; they still do not imply an all-clear.

Each NSE file is parsed once per load, whether downloaded or read from disk. Undefined-value diagnostics therefore appear once per affected date/symbol/field in that load, rather than twice for newly downloaded files. Model-facing evidence-ID schemas use independent string definitions to avoid nested JSON references rejected by provider grammar parsers; citation validation remains unchanged.

Raw P/E CSVs and PR ZIPs are cached under `data/nse/YYYY-MM-DD.pe.csv` and `YYYY-MM-DD.pr.zip`, with two-calendar-month retention. Each run allows at most **31 new P/E files and 31 new PR ZIPs**, separately from the unchanged 31-bhavcopy cap; cached files do not consume those budgets. New job status includes `nseDownloads` and per-stock NSE context. Reports show current available P/E and known NSE action notices, not the P/E history table.

### Sequential TradingView enrichment

After all Tavily research completes, stocks with an Unsure outlook or without P/E or market cap anywhere in their NSE current/history data are enriched one at a time using the vision scrape service at `https://in.tradingview.com/symbols/NSE-{symbol}/`. The extraction asks for the displayed ticker, TTM P/E and EPS, market cap, FY revenue and net income, indicated dividend yield, one-year beta, sector, industry and company description. Values are read with their displayed units and periods; missing or mismatched symbols and entirely empty extractions are rejected. NSE current and historical figures remain authoritative, and TradingView fills only missing P/E or market cap. Market cap is converted to INR crore only when currency and units are unambiguous. Other key stats are supplemental analysis evidence, not new structured metrics. The scrape retrieval time is not a financial reporting date.

The final assessment uses the already captured Tavily results, NSE context and TradingView extraction; its only available model tool is the structured submission tool, so no Tavily searches are repeated. One retry after 45 seconds is allowed for network/timeout or rate-limit errors; other errors are not retried. Failed enrichment or reassessment retains the original research with a warning. Reports and database publication happen only after this stage. Scrape results do not extend or overwrite the background research cache.

**Paused model fields:** debt/equity, earnings-growth percentage, company-sector P/E, live price/quote timestamps, and the blanket `corporateActionsClear` claim. No reliable normalised daily-file source was verified for debt/equity or earnings growth; financial-results announcements are not the underlying financial statements. NSE index files expose index P/E, but there is no verified point-in-time mapping here to treat that as every company's sector P/E. Daily bhavcopies give dated closes, not live quote timestamps. Corporate-action notices are useful positive evidence, but an absent notice does not establish a split/bonus/rights-free history.

These paused fields, NSE-owned metrics, financial period and the fixed outlook horizon are removed from the **model-facing submission schema**, not merely hidden on the public page. P/E/market cap/action evidence are attached by the application; the horizon is set locally to `next_trading_week`. Explicit metric-search queries are blocked before executing Tavily. Current research does not emit extraction/freshness warnings for the paused fields. Legacy schemas/normalisation remain for compatibility with existing caches, audit records and diagnostic tools, and old files are not rewritten.

Search date filters do **not** guarantee real-time market information. Publication dates and retrieval times remain separate. Missing dates or stale news evidence are **warnings, not rejection gates**. The researcher makes the best supported judgment using available information and dated NSE/bhavcopy context. It must not delegate routine research to the scrape-based live-data sub-agent or launch parallel scrapes.

The pinned dependency uses one `TAVILY_API_KEY`; it does **not** implement Tavily key rotation. LLM-provider rotation is separate. If your installation uses a newer/custom framework with Tavily key rotation, these callback-based evidence checks do not replace its search tools or credential management.

**News citations and corroboration checks are best effort.** Unknown IDs never create source records; missing context, limited source diversity or stale sources do not reject an assessment. `assessment_warning` events identify issues by field and code, retained in the audit. Missing NSE metrics alone must not force Unsure. NSE record excerpts are application-normalized parsed rows with explicit date/units, not model-supplied quotations. Research considers those facts alongside volume/liquidity, volatility, news, governance and catalysts.

Every stock receives a `profit_probability` category for a **long investment over the next trading week**, relative to research time:

| Category | Meaning |
|---|---|
| `high` | Strong corroborated evidence of upside, continued gains or recovery |
| `medium` | Mixed evidence or a balanced directional outlook |
| `low` | Weak upside or evidence of further decline, including falling stocks likely to fall more |
| `null` | **Unsure**: inconclusive/no research, or research failed; the reason is retained |

A falling stock can be `high` if recovery is well supported; a rising stock can be `low` if reversal risk dominates. Historical movement alone never determines the category. This is not a numerical probability, expected profit amount or short-selling signal. Classification and data-gap reasons are logged and retained in run records, not written to Supabase. Missing evidence must not be disguised as `medium`. `null` is the existing database representation of Unsure; there is no new category or migration.

Evidence is checked against the one-hour retrieval benchmark and bounded background-cache policy. Dated NSE file observations are not presented as live quotes. Rechecking before publication adds relevant warnings when evidence ages; it does not erase the model's directional decision. With no captured NSE or news evidence, the result is Unsure rather than an invented prediction.

**Every selected stock remains in the batch, up to the existing top-25 gainers limit.** Provider errors, timeouts, exhausted model/tool budgets or missing structured submissions produce an explicit `research_failed_continuing` event and an Unsure row, then the next stock is processed. Such failures are recorded, not represented as successful research or cached as such. Unusable submission fields are handled locally without a correction request; wrong-stock claims are not attributed to the selected stock, which remains Unsure. Publication always uses the candidate's bhavcopy close and movement, not an unverified model quote. A bhavcopy close is dated end-of-day context, not a real-time price.

Run records retain `screened` matches and per-stock `stockOutcomes` (category, bhavcopy price/date, explanations, warnings and research failure details). Outcomes are saved after each stock and survive successful intermediate cleanup. `run_completed` includes Unsure and research-failure counts. Download/reset failures, disk persistence failures and Supabase errors still fail explicitly; uncertain inserts are not automatically replayed.

Legacy quote-timestamp parsing remains for old assessment/cache compatibility. New runs neither request these fields nor run quote-freshness checks. Article publication/retrieval dates are never used as intraday quote timestamps.

### Disk-cached background research

Completed stock research is cached by ISIN in `data/research-cache/ISIN.json`, retaining warnings, captured source content, original observation times and the comparison window. If younger than half the current `LOOKBACK_DAYS` (15 days by default), reuse dated business/sector context. Each run supplies its own dated NSE file metrics; cached numerical metrics and action-clear flags are not reused. Cache hits never extend the original research age. Expired or absent entries trigger full news/business research.

**Cache hits use a constrained refresh, not the general planning/research loop.** The application runs **one fixed material-company-news search** through the framework Tavily tool: `topic="news"`, `days=7`, `maxResults=3`. It does not search for quotes or numerical metrics. Then the model normally makes one structured assessment request. It may read one bounded source page first (at most two successful model responses total), but cannot delegate, crawl, scrape, repeat searches or plan TODOs. Recognized network failures can retry once; provider rotation, existing budgets and the original deadline still apply. Search failures become explicit warnings; the assessment proceeds using dated NSE/business context.

Cached pages are **not injected in full**. Serialized compact context is capped at **12,000 characters**, including citation IDs, dated business risk/catalyst summaries and bounded source previews. Fresh sources and cited background records are prioritised. Sentences containing digits are excluded from cached narratives, cached previews and cached evidence pages, so old P/E, earnings percentages, prices and other embedded numbers cannot re-enter through prose. This deliberately sacrifices some dated qualitative context; original timestamps and source URLs remain provenance, not current metric claims. Fresh news and this run's dated NSE figures remain available. Full captured source text remains unchanged for audit/citation resolution; `read_research_evidence` exposes a filtered page by evidence ID/raw-source offset, capped at **6,000 serialized characters**. No previous profit category, quote, numerical-metric object or corporate-action-clear flag is supplied as a reusable prediction.

`research_cache_hit`/`research_cache_miss` describe background reuse. `research_started.mode` distinguishes `cached_refresh` from `full_research`; `cached_refresh_search`, `cached_refresh_assessment` (including `contextChars`), `cached_refresh_evidence_read` and `cached_refresh_warning` show the bounded work performed.

Cache-hit responses need not fail solely because the model returned prose or bundled tool calls. A single assessment bundled with other calls is retained and the extras are discarded before execution (`cached_refresh_extra_calls_discarded`). With no unambiguous assessment or permitted single evidence read, one submission-only completion recovery is allowed (`cached_refresh_completion_repair`), using the existing evidence and budgets without repeating searches. Conflicting assessments are not executed or arbitrarily selected. If recovery also fails, the stock remains explicitly Unsure. Accepted submissions are never sent back for correction.

Cached context is intentionally not real-time news. Its original research date is logged and a background-age caveat is added to the risks. Known NSE action notices are supplied anew; no action-free coverage claim is made. Corrupt, identity-mismatched or future-dated caches cause explicit per-stock failure/Unsure rather than stopping remaining stocks; renamed tickers trigger fresh research. Empty-evidence results and failures are not cached. This cache is independent of Neon and survives intermediate cleanup/framework resets.

### Research diagnostics and limits

Each stock logs `research_started`, model starts/completions/errors, proposed tools, executed tool starts/ends/errors, `assessment_warning` and `assessment_accepted`. `research_model_start`, `research_model_end` and `research_model_error` correlate through `modelRunId`; completion/error events include call duration and errors include their type, not raw provider responses. A start without a matching end/error before the overall deadline indicates an unfinished model request. `assessment_schema_warning` diagnostics show field paths, issue codes, expected and received types (`undefined` distinguishes missing fields), and object key names only, never field values. Events include the application run ID and stock symbol, plus tool IDs where available, but not raw tool arguments, page contents or credentials.

The model-facing submission contains the category, explanations, comparative risk/recovery scores, narratives, `evidenceIds.marketEvidence` and optional `additionalEvidenceIds`. Financial metrics, quote fields, corporate-action flags, financial period and the fixed horizon are application-owned or paused. Captured IDs are scoped to one stock evaluation; the application resolves them to source records. `list_research_evidence` exposes the current registry without another search.

The retained **legacy** metric normaliser accepts explicit numeric/unit formats and checks cited numbers without guessing units from magnitude. It is not a request to research the paused fields. New NSE parsers validate their documented columns and perform the explicit INR-to-crore conversion directly. New model prompts use complete, reduced-schema classified/Unsure examples, marked as synthetic rather than evidence.

NVIDIA can emit `"None"` for JSON null. This token is converted only where the active schema accepts null (category, comparative scores and market-evidence ID), never in narrative text or unknown keys. Legacy numeric/timestamp handling remains covered by the captured synthetic provider fixture, `test/fixtures/nvidia-none-assessment.json`.

An empty/whitespace or literal `null` string in `dataGapReason` becomes JSON null **only for a classified stock**. Supplied explanations must satisfy structural constraints. If an Unsure result lacks an explanation, the application records the actual missing-evidence/inconclusive-outlook condition; a research fallback records the concrete failure. Caveats supplied on classified results are retained as warnings/risks rather than causing rejection.

Category capitalization/outer whitespace is normalized (` HIGH ` becomes `high`); explicit Unsure/unknown/null tokens become JSON null. A short classification explanation can be expanded using the model's own usable supporting reason, never invented rationale. Unsupported categories such as percentages remain Unsure. Model-facing prompts explicitly require the allowed category literals and a reason of at least 20 characters.

Numerical valuation/date assertions in narratives are checked against supplied NSE history: unobserved ISO dates or unsupported number/date pairs such as `5.13 on 2026-10-03` are removed and logged as `historical_nse_claim_mismatch`, not silently corrected to another date. If the classification explanation relies on that unsupported claim, the outlook becomes Unsure. This is a targeted valuation/date check, not verification of every prose claim. Research-failure diagnostics retain available NSE evidence and distinguish unavailable business/news research from missing financial context.

**There are no evidence or schema resubmission rounds.** The first submission is normalized and usable fields are retained; malformed metrics become unknown, and missing/invalid decision fields produce Unsure with an explicit explanation. Valid nested citation entries survive invalid sibling entries. Wrong-stock claims are discarded rather than assigned to the requested stock. All problems become field-specific warnings without asking the model to correct them. Duplicate submission tool calls receive the already finalized outcome and cannot overwrite it or execute another submission. Unexpected worker/tool/provider failures are recorded explicitly as research failures. Supabase payloads are unchanged.

Only identified transient network failures permit an application-level retry of the same request, **once**: connection/DNS/timeouts and HTTP 408/502/503/504. Each retry logs `research_network_retry` and remains inside the original model/tool budgets and wall-clock deadline. Read-only research tools can retry; uncertain Supabase inserts are never replayed. Content/evidence errors, invalid JSON, authentication errors and cancellation do not trigger this retry. Existing provider SDK retries and framework quota/provider rotation remain separate.

If the model finishes with prose without ever submitting, `assessment_completion_repair` requests **its first structured submission**, using the same model handler, conversation and captured evidence. This is not a correction/resubmission round. Only `submit_stock_assessment` is available; it does not restart research or run additional searches. It shares the existing deadline and budgets. Unusable fields are handled locally. Repeated prose or failure to obtain an assessment yields an explicitly recorded Unsure stock, not an invented prediction. No repair or further model request is needed after acceptance.

Per-stock defaults (configurable in `.env`, loaded when a run creates its researcher):

| Variable | Default | Meaning |
|---|---|---|
| `RESEARCH_TIMEOUT_MS` | `360000` | Six-minute wall-clock deadline per stock, including worker startup |
| `RESEARCH_CONCURRENCY` | `5` | Independent stock research processes per batch, 1–25; `1` is sequential |
| `RESEARCH_MAX_MODEL_CALLS` | `20` | Model requests, including delegated research |
| `RESEARCH_MAX_TOOL_CALLS` | `40` | Proposed tool calls, including invalid proposals |

`RESEARCH_MAX_SUBMISSIONS` has been removed; an old value in an existing `.env` is ignored.

Each stock runs in its own isolated child process because the pinned framework does not expose cancellation through `DeepAgentRunner.run()` and its tools do not consistently support abort signals. Deadline or budget exhaustion terminates that stock's process without cancelling its peers. Batches run up to `RESEARCH_CONCURRENCY` stocks concurrently, then persist outcomes serially in original shortlist/rank order before starting the next batch; publication still waits for all research. Setting concurrency to `1` restores sequential execution. All processes in a batch settle before audit writes, so an audit failure cannot leave background research running into cleanup. Shared provider quotas still apply; lower concurrency if throttled. Previously accepted remote provider requests cannot be undone. Incomplete model prose is never published as a prediction. The existing graph recursion limit remains a separate backstop.

Unadjusted HIGH/LOW changes can be misleading around splits, bonuses, rights issues, demergers and ISIN changes. The researcher considers continuity where information is available and records uncertainty as a risk rather than treating nominal movement as a guaranteed return. The preselected row is never removed or replaced because research is incomplete.

For context only, the retained risk score is a transparent **relative scoring heuristic**, not a ranking input or calibrated financial risk model:

```text
volatilityComponent = min(100, annualized log-return volatility × 100)
liquidityComponent  = 100 / (1 + average daily turnover in INR / 10,000,000)
observedRisk       = 0.6 × volatilityComponent + 0.4 × liquidityComponent
finalRisk          = 0.4 × observedRisk + 0.6 × researched fundamentalRisk
```

The agent may supply `fundamentalRisk` and `recoveryScore` on 0–100 comparative scales when supported; otherwise they can be null. Neither determines the list's order. It must explicitly explain the profit category, uncertainty and downside risks. These best-effort LLM assessments require human review; warnings are not evidence verification, and acceptance is not a guarantee of accuracy, safety or returns.

## Supabase semantics

### Public stock reports

Each selected stock gets a responsive, script-free HTML page with an inline SVG chart and an accessible price table. There are no plotting libraries, external assets or browser-rendering requirements; each page is limited to 64 KB. Pages retain useful classification reasoning, business risks, catalysts, market context, supported financial metrics and whether cached background was reused (including its original research date). Technical extraction/citation warnings, failed fields and unverified numeric metric cards are omitted from the public presentation, **not deleted from the audit**. Classification semantics and shortlist membership are unchanged.

Charts use the latest **`min(5, LOOKBACK_DAYS)` available trading observations**, ending on the screening date, plotted oldest to newest. A 2/3-day setting plots at most 2/3 observations. Closes are matched by ISIN; missing archives/weekends are skipped, with older history backfilled when necessary. Special weekend sessions are included if an archive exists. Prices are unadjusted bhavcopy closes, not intraday LTP or model-reported quotes. Backfill shares the 31-download cap and stops within two calendar months; if insufficient history exists, the page and logs explicitly show the smaller actual count rather than inventing points.

Objects use `stock-reports/{run_id}/{gainers|losers}/{stockcode}.html`; URL path segments are encoded (including `M&M`). Reports upload and their references are persisted **before any Supabase count/delete/insert**. Upload failure fails the job rather than publishing rows without reports. A later database failure can leave orphaned public objects, which the lifecycle cleans up; it never triggers automatic publication replay. Both group paths are supported, but losers remain paused.

- Original `price` is the screening day's close; `change` / `change_percent` are HIGH/HIGH deltas over the configured period, **not daily quote changes**. The LOW/LOW loser path is paused.
- Insert payloads contain **only** `name`, `price`, `change`, `change_percent`, `updated_at`, `profit_probability` (`low`, `medium`, `high` or null), and `report_url`. Every new row requires an uploaded, unexpired HTTPS report reference before database operations. The existing identity `id` is database-generated and used only for targeted retention deletes.
- No research bodies, sources, reasons, scores or intermediate state are stored in Supabase; the report URL identifies the run, group and symbol. Incoming arrays retain rupee-movement order, but physical SQL row order is not meaningful. For historical display use explicit ordering, for example `updated_at DESC, change DESC` for gainers.
- Each active table is handled independently using direct Supabase queries (`top_gainers` only while losers are paused): count rows; if there are **100 or more**, select/delete the **oldest 25** by `updated_at ASC NULLS FIRST, id ASC`; then insert up to 25 final rows. Legacy rows without timestamps are pruned first.
- This is batch retention, not a strict 100-row cap: 99 existing rows plus 25 new rows yields 124. Existing oversized tables lose 25 per publication.
- **Writes are not atomic across queries.** Deletions can succeed before insertion fails. Disk progress records `pending`, `cleanup_started`, `cleanup_done`, `insert_started`, and `inserted` for active tables; losers are marked `paused` and left untouched. An interrupted `insert_started` may already have committed remotely. Never blindly replay it: compare the stored final payload/timestamp with database rows and reconcile manually before retrying.
- Inserts are not automatically retried, and the same disk publication record is not automatically replayed. There is deliberately no database idempotency infrastructure. Use one writer/service instance; external writers can race the count/delete sequence.

The exact row count uses a bounded GET returning at most one `id`, not HEAD, so failed requests retain Supabase's error body. Count/lookup/delete/insert failures include HTTP status and available error codes/details/hints. A missing or invalid count fails before any deletion or insertion. HTTP 401 with `Invalid API key` requires correcting `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` locally so they belong to the same project; changing count handling cannot make rejected credentials valid. Do not paste credentials into logs or chat.

## Disk storage and operations

```text
data/bhav/YYYY-MM-DD.csv                  original validated daily equity CSV
data/nse/YYYY-MM-DD.pe.csv                NSE daily security P/E CSV
data/nse/YYYY-MM-DD.pr.zip                NSE daily PR package (market cap/event notices)
data/research-cache/ISIN.json              reusable background research and dated source evidence
data/reduced/YYYY-MM-DD.json              filtered current universe and history
data/runs/YYYY-MM-DD.UUID.json            job status; temporary research while publishing
data/runs/UUID.publication.json           temporary final payload and per-table write progress
data/.run.lock                           exclusive active-run lock
```

The data path is configurable through `DATA_DIR`. After **all active tables publish successfully**, the run's reduced data, publication progress and any legacy audit file for that run are deleted. The job JSON retains status/counts, screened matches and compact per-stock outcomes with explanations, warnings and failure details; full intermediate research results are removed. Raw bhavcopy CSVs and NSE P/E CSVs/PR ZIPs remain cached; recognized dated files older than **two calendar months** are deleted at run start and finish. Background research cache files are retained. Failed/uncertain run files are retained for manual inspection rather than erased by age-based cleanup. If cleanup itself fails after insertion, the failed status includes confirmed `inserted` counts: do not republish simply to retry file cleanup. Credentials remain outside this directory. Neon framework state is independent of Supabase results and the disk cache.

At phase `resetting_framework`, the run truncates only the six public framework tables (`agent_runs`, `agent_todos`, `agent_events`, `agent_custom_state`, `checkpoints`, `checkpoint_writes`) in one SQL statement with identity reset and **without `CASCADE`**. Tables and unrelated data are retained. Missing tables or external foreign-key dependencies fail explicitly before downloads or research; run `npm run db:setup` first. The reset occurs once per accepted run, including runs later skipped for unavailable archives, never for rejected overlapping requests. Logs include `framework_state_cleared`. Use one service instance for the dedicated Neon database: different data-directory locks do not protect a shared Neon database from another instance's reset.

Use one service instance per shared data directory. The run lock prevents overlapping publishers using that directory. A crash leaves the lock in place deliberately: inspect the recorded PID/run, confirm no process is active, and reconcile disk publication progress with Supabase before removing **only** the stale `.run.lock` and restarting. Without a lock, interrupted jobs are marked failed at startup, not automatically republished. A new trigger refreshes news/outlooks and reuses valid background research and cached NSE files; it does not repair or undo earlier partial database writes. Provider swaps within a live framework run retain its checkpointed work until the next accepted application run resets Neon.

Do not delete the data directory during an active run. Graceful shutdown stops accepting requests and waits for active work. Logs include each stock's profit category, reasons and data gaps; Supabase contains only the display payload.

## Development

```sh
npm test
npm run build
```

Tests use deterministic ZIP/CSV fixtures, mocked research/Supabase HTTP responses, a real localhost HTTP server and embedded PostgreSQL (PGlite) for fresh/upgrade migration checks. Live NSE, LLM, scraping, Neon and Supabase execution requires network access and valid credentials; these tests do not pretend to be live-market validation.

To check two real NSE files without calling research providers or writing to Supabase:

```sh
npm run test:bhav -- 2026-09-25 2026-10-26
```

This opt-in check uses the current screening settings, active groups and the production downloader/parser. It independently cross-checks active price filtering, every HIGH/HIGH delta, and the top-25 rupee order against raw CSV fields; round-trips reduced JSON and the report; and proves cached reads work with networking disabled. The report includes the ordered gainer shortlist and an empty paused loser shortlist. Files are retained under `data/live-verification/`. Pick two published trading dates; this verifier expects modern UDiFF files and does not discover the baseline date automatically. It uses only the two endpoints, **not** the full configured period's observations, so its volume/volatility fields must not be used for investment analysis. It does not generate live profit categories or publish to Supabase. No Supabase credentials are needed.
