# NSE stock research agent

TypeScript service built around [`freetier-deepagent-framework`](https://github.com/RY0502/freetier-deepagent-framework) (LangGraph / Deep Agents). An unauthenticated HTTP request starts a disk-backed job that screens NSE equity bhavcopies, researches qualifying companies on live pages, and appends only final display data to Supabase.

**Research only, not trading or financial advice.** Profit categories are qualitative outlooks for the **next trading week**, not numerical probabilities or guarantees of returns.

## Setup

Requires Node.js 22+ and npm.

```sh
npm ci
cp .env.example .env
```

Populate `.env` locally. Never commit credentials. Use the Supabase **service-role** key server-side only. Neon is used for framework state/checkpoints; Supabase is used for results. The pinned framework requires all five listed main-provider keys plus Tavily and Neon, even if an earlier provider handles the entire run. See its repository for optional sub-agent provider configuration and model overrides.

```sh
npm run db:setup
```

Apply **`supabase/migrations/001_profit_probability.sql`** in the Supabase SQL editor or your migration tool. This is the only migration: it adds nullable `profit_probability` to your existing `top_gainers` and `top_losers` tables, constrained to `low`, `medium`, `high` or null. It can be run repeatedly and preserves existing columns, IDs and data. It creates no tables, functions or indexes, and changes no access policies. The existing tables must already exist. Configure RLS for your consuming application and allow the server's service-role key to select/count, delete and insert.

```sh
npm run build
npm start
# or: npm run dev
```

The framework revision is pinned in `package.json`; transitive resolutions are recorded in `package-lock.json`. The upstream repository ships its compiled library.

## HTTP API

The server binds to `127.0.0.1:3000` by default. **There is deliberately no authentication**, per the requested design. Anyone able to reach it can consume research quotas, append results and prune history. Keep it on a trusted network; exposing `HOST=0.0.0.0` publicly is unsafe.

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

`POST /runs` returns `202` with an ID and status URL; it does not wait for research. Omitting the date means today's date in Asia/Kolkata. Invalid/future dates return `400`; overlapping runs return `409`. Status progresses through `queued`, `running`, `publishing`, and `completed` or `failed`. A small final status record retains settings, counts and completion status, but not research results/reasons. Reasons and data gaps are printed to server logs. An empty shortlist inserts no rows but still participates in the table's retention check.

The requested day's file **must exist**. Before publication, on a non-trading day, or if NSE returns an error, the run fails without substituting a previous day's file. Run after NSE actually publishes the daily file. An older screening date still receives **current research** and a next-trading-week outlook relative to research time, not historical fundamentals or a historical prediction; this is not a backtesting service.

## Screening configuration

The six settings below are read for **each new run** and saved in its status record. Update `.env` before triggering another run; screening changes do not require restarting the service. Values in `.env` take precedence over process environment values for these six settings only. Other service/provider settings remain startup configuration.

```dotenv
GAINERS_INCREASE_RS=100
LOSERS_DECREASE_RS=100
GAINERS_MIN_PRICE=200
GAINERS_MAX_PRICE=2000
LOSERS_MIN_PRICE=200
LOSERS_MAX_PRICE=1500
```

Amounts must be positive, finite and have at most two decimal places. Each minimum must not exceed its maximum. Invalid settings fail explicitly. A running job keeps its initial settings even if `.env` changes halfway through it.

## Screening rules

1. Download the NSE cash-market UDiFF ZIP/CSV for the requested date. Dates before 2024-07-08 use the legacy equity archive convention. Validate headers, trading dates, numeric fields, OHLC and ISIN identity. Keep traded `EQ` stock rows, not other series/instrument types or zero-volume rows (which can carry stale closes and zero HIGH/LOW).
2. Filter the requested day's **closing price** using each group's inclusive configured range: by default ₹200–₹2,000 for gainers and ₹200–₹1,500 for losers. Save the union of both universes as a reduced dataset and only carry these ISINs into history processing. Raw daily CSVs remain intact so a future run can use different settings.
3. Use the same calendar date one month earlier, clamped to month-end. If absent, find the nearest available bhavcopy on or before that date (up to 10 calendar days backward).
4. Gainers: `latest HIGH − baseline HIGH ≥ GAINERS_INCREASE_RS`. Losers: `latest LOW − baseline LOW ≤ −LOSERS_DECREASE_RS`. There is **no secondary threshold/filler pass**. Percentage change uses the corresponding baseline HIGH or LOW. These are endpoint comparisons, not the greatest excursion during the month; a stock can qualify for both groups.
5. Load intervening daily files for volume, turnover and close-to-close volatility. Latest volume is compared with the mean of earlier observations, excluding the current day. Match history by ISIN, allowing ticker renames. Companies without baseline history are excluded.
6. **Before research**, sort gainers by monthly percentage increase descending, and losers by absolute monthly percentage loss descending (signed values such as −30%, −20%, −10%). Keep at most **25 per group**, with symbol/ISIN tie-breakers. Only those stocks are researched. Preserve this membership and order after research; risk scores and profit categories never rerank or remove stocks. If fewer than 25 meet the configured screen, publish fewer without fillers.

Historical NSE `404` dates are omitted and explicitly recorded; they are **not claimed to be verified holidays**. Weekends are probed too because special sessions can occur. Access denial (`403`), rate limits, timeouts, malformed/corrupt archives, and schema drift fail the run rather than masquerading as holidays. There is no anti-bot bypass. NSE may restrict downloads from your deployment network.

At most **31 successfully downloaded bhavcopy files** are allowed per run, shared by both groups. Cache hits and `404` responses do not consume this budget. Normally a calendar month has fewer trading sessions; if a rare set of sessions/baseline dates would require more than 31 uncached files, fail explicitly rather than exceed the cap or silently shorten the window.

## Live research and profit categories

Each shortlisted entry is evaluated through `DeepAgentRunner`, retaining the framework's provider rotation, Neon checkpoints and research/live-data sub-agents. Tavily discovers sources; **cached search snippets alone cannot support a category**. Callback auditing captures `vision_scrape` page reads. A structured submission tool validates each assessment; free-form agent prose cannot directly publish results.

Classified stocks require a live quote with timestamp, market cap, an identified financial reporting period, a verified corporate-action check and market context. Numeric values must occur in their cited verbatim live-page excerpts, with evidence from at least two source domains. Research considers P/E, sector P/E, leverage, earnings growth, volume/liquidity, volatility, news, governance and catalysts. Negative P/E or distress can support a **low** category rather than excluding the stock; missing optional metrics must be discussed as risks. Financial statements are latest-reported figures, not “real-time” earnings.

Every stock receives a `profit_probability` category for a **long investment over the next trading week**, relative to research time:

| Category | Meaning |
|---|---|
| `high` | Strong corroborated evidence of upside, continued gains or recovery |
| `medium` | Mixed evidence or a balanced directional outlook |
| `low` | Weak upside or evidence of further decline, including falling stocks likely to fall more |
| `null` | Insufficient verified evidence; an explicit `data_gap_reason` is required |

A falling stock can be `high` if recovery is well supported; a rising stock can be `low` if reversal risk dominates. Historical movement alone never determines the category. This is not a numerical probability, expected profit amount or short-selling signal. Classification reasons and data-gap reasons are printed in logs, not written to Supabase. Missing evidence must not be disguised as `medium`.

The quote must be no more than 96 hours old (to accommodate normal market closures); the page itself must have been read within the last hour. Evidence is revalidated immediately before publication. Source observation times and actual quote times are stored separately. Insufficient evidence leaves the shortlisted stock present with a null category and a reason. If previously valid evidence expires while other stocks are researched, its category becomes null with an expiry reason, not a stale prediction. Infrastructure/provider failures or missing structured submissions still fail the run and preserve existing results; they are not silently converted to successful research.

Unadjusted monthly HIGH/LOW changes can be misleading around splits, bonuses, rights issues, demergers and ISIN changes. The researcher must verify corporate-action continuity and leave affected or unverified series unclassified with a reason rather than treating nominal changes as genuine gains/losses. The preselected row is not removed or replaced.

For context only, the retained risk score is a transparent **relative scoring heuristic**, not a ranking input or calibrated financial risk model:

```text
volatilityComponent = min(100, annualized log-return volatility × 100)
liquidityComponent  = 100 / (1 + average daily turnover in INR / 10,000,000)
observedRisk       = 0.6 × volatilityComponent + 0.4 × liquidityComponent
finalRisk          = 0.4 × observedRisk + 0.6 × researched fundamentalRisk
```

The agent may supply `fundamentalRisk` and `recoveryScore` on 0–100 comparative scales when supported; otherwise they can be null. Neither determines the list's order. It must explicitly explain the profit category, uncertainty and downside risks. These LLM assessments, screenshots and source independence still require human review; validation establishes captured evidence provenance, not that every source or interpretation is correct.

## Supabase semantics

- Original `price` is the screening day's close; `change` / `change_percent` are monthly HIGH/HIGH or LOW/LOW deltas, **not daily quote changes**.
- Insert payloads contain **only** `name`, `price`, `change`, `change_percent`, `updated_at`, and `profit_probability` (`low`, `medium`, `high` or null). The existing identity `id` is database-generated and used only for targeted retention deletes.
- No ranks, symbols, research, sources, reasons, scores, run IDs or intermediate state are stored in Supabase. Incoming arrays retain monthly-movement order, but physical SQL row order is not meaningful. For historical display use explicit ordering, for example `updated_at DESC, change_percent DESC` for gainers and `updated_at DESC, change_percent ASC` for losers.
- Each table is handled independently using direct Supabase queries: count rows; if there are **100 or more**, select/delete the **oldest 25** by `updated_at ASC NULLS FIRST, id ASC`; then insert up to 25 final rows. Legacy rows without timestamps are pruned first. A table below 100 rows is not pruned just because the other table is full.
- This is batch retention, not a strict 100-row cap: 99 existing rows plus 25 new rows yields 124. Existing oversized tables lose 25 per publication.
- **Writes are not atomic across queries or tables.** Deletions can succeed before insertion fails, and gainers can insert before losers fail. Disk progress records `pending`, `cleanup_started`, `cleanup_done`, `insert_started`, and `inserted` per table. An interrupted `insert_started` may already have committed remotely. Never blindly replay it: compare the stored final payload/timestamp with database rows and reconcile manually before retrying.
- Inserts are not automatically retried, and the same disk publication record is not automatically replayed. There is deliberately no database idempotency infrastructure. Use one writer/service instance; external writers can race the count/delete sequence.

## Disk storage and operations

```text
data/bhav/YYYY-MM-DD.csv                  original validated daily equity CSV
data/reduced/YYYY-MM-DD.json              filtered current universe and history
data/runs/YYYY-MM-DD.UUID.json            job status; temporary research while publishing
data/runs/UUID.publication.json           temporary final payload and per-table write progress
data/.run.lock                           exclusive active-run lock
```

The data path is configurable through `DATA_DIR`. After **both tables insert successfully**, the run's reduced data, publication progress and any legacy audit file for that run are deleted, and the job JSON is reduced to a small status/count summary with no research/reasons. Raw bhavcopy CSVs remain cached and files older than **two calendar months** are deleted at run start and finish. Failed/uncertain run files are retained for manual inspection rather than erased by age-based cleanup. If cleanup itself fails after insertion, the failed status includes confirmed `inserted` counts: do not republish simply to retry file cleanup. Credentials remain outside this directory. The framework's pre-existing **Neon** checkpoint/state mechanism is independent of this minimal Supabase design; it is not a Supabase research/logging store.

Use one service instance per shared data directory. The run lock prevents overlapping publishers using that directory. A crash leaves the lock in place deliberately: inspect the recorded PID/run, confirm no process is active, and reconcile disk publication progress with Supabase before removing **only** the stale `.run.lock` and restarting. Without a lock, interrupted jobs are marked failed at startup, not automatically republished. A new trigger starts fresh research but reuses cached CSVs; it does not repair or undo earlier partial database writes. Provider swaps within a live framework run retain its checkpointed work.

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

This opt-in check uses the six current screening settings and the production downloader/parser. It independently cross-checks per-group price filtering, every HIGH/LOW delta, and the top-25 percentage order against raw CSV fields; round-trips reduced JSON and the report; and proves cached reads work with networking disabled. The report includes both ordered shortlists. Files are retained under `data/live-verification/`. Pick two published trading dates; this verifier expects modern UDiFF files and does not discover the baseline date automatically. It uses only the two endpoints, **not** a full month's observations, so its volume/volatility fields must not be used for investment analysis. It does not generate live profit categories or publish to Supabase. No Supabase credentials are needed.
