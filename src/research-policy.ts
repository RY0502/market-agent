export const NSE_RESEARCH_POLICY = `P/E, adjusted P/E, market cap and known corporate-action events
are supplied in candidate.nse from dated NSE files. Use them in your next-trading-week judgment;
compare available historical P/E observations without treating P/E changes as earnings growth.
Every numerical valuation/date claim must match an observation in candidate.nse.history exactly;
do not reconstruct missing dates or carry numerical claims from cached narratives into the decision.
SYMBOL P/E is the primary P/E; ADJUSTED P/E is a separate NSE figure, not an interchangeable substitute.
Market cap is in INR crore. Never replace supplied NSE figures with web/model figures.
When an analysis-date metric is missing, candidate.nse.historical supplies the latest valid older
observation within the analysis window, if any. Use it only as historical context, explicitly cite
its asOf date, and consider that valuation may have changed. Each metric has its own date.
Never describe a historical fallback as current or live, or use adjusted P/E in place of SYMBOL P/E.
Debt/equity, earnings-growth metrics, company-sector P/E and live quotes/timestamps are PAUSED.
Do not search, crawl, scrape, infer, extract or submit these paused metrics. Do not fetch P/E,
market cap or structured corporate-action data through Tavily either: use the supplied NSE files only.
Research company/sector news, governance, catalysts and business risks, alongside bhavcopy volume,
liquidity and volatility. Relevant earnings announcements may inform qualitative reasoning, not
an extracted earnings-growth metric. A missing NSE figure is unknown, never zero or an invitation
to search for a replacement. Use supplied dated historical context where available.
NSE files are dated end-of-day data, not live quotes.
Corporate-action records are positive event notices only; absence does not prove continuity or
adjusted prices. Do not claim corporateActionsClear. Do not reuse old cached numerical metrics.

Explain the investment case in everyday language: what happened, any verified dated business
explanation, what supports continuation, what could reverse it, what is missing and what would
change the view. If no verified catalyst was found, say so; do not infer one from a price spike.
Prefer dated exchange filings and company investor-relations disclosures over copied commentary.
Use candidate.priceSignals when supplied: first/latest >=5% observed-close interval, observations
since the move, spike volume versus preceding observations, subsequent activity, gain retained,
concentration of positive price moves and peak-to-trough drawdown. Dates may span missing
archives or sessions; never call an interval a single trading day without verification.
These are deterministic UNADJUSTED historical measurements, not causal proof or forecasts.
If corporate actions may explain a jump, disclose that before interpreting buying interest.
P/E and company size are background, not next-week timing signals. Company size alone does not
establish financial strength, liquidity or safety. No universal P/E or leverage threshold proves
cheapness or safety; comparable period, accounting basis and industry are required.
Missing P/E is unknown, not proof of losses. Only explain P/E as not meaningful for loss-making
companies when matching captured earnings evidence establishes that. Do not average conflicting
figures: distinguish TTM/annual, consolidated/standalone, dates, currency and units.
Keep outlook, evidence confidence and downside risks distinct. In reasons explain what actually
supports the view; in risks explain reversal scenarios; in recoveryCatalysts explain observable
developments that would change the view, without inventing target prices or events.

Differentiate between established brand/thematic compounders and obscure, low-liquidity speculative stocks.
Stocks with high daily turnover (> INR 10-25 Cr), prominent brand recognition, or verified institutional
backing (DII/FII) frequently digest short-term gains through tight consolidations or healthy pullbacks
before resuming their multi-week trend; do not mistake orderly consolidation in structural brand leaders
for trend failure. Conversely, lesser-known, low-turnover (< INR 5 Cr), or obscure microcaps that have
surged over the lookback window are frequently in late-stage operator distribution or liquidity exhaustion.
Without verified institutional sponsorship or transformative structural business fundamentals, price surges
in low-liquidity obscure stocks are high-risk bull traps that mean-revert downward; rate them low profit
probability or null (Unsure) and highlight illiquidity and distribution risks.
Assess whether the company rides durable secular macro tailwinds (e.g., Defence capex supercycle,
EV/green transition, digital royalty/IP moats with ROCE > 25% and low leverage) versus cyclical/commodity/
working-capital-intensive businesses (e.g., seasonal agrochemicals, commoditized raw materials). Structural
leaders have high trend resilience; cyclical commodity stocks without structural margin expansion face rapid
multiple contraction. Use candidate.priceSignals to distinguish orderly accumulation (high spike gain retained,
steady volume ratio, shallow drawdown) from climax/blow-off tops (isolated parabolic volume spike followed by
drying turnover and immediate give-back).

Layman-Friendly Explanations:
Frame all findings, reasons, and risks in clear, intuitive, layman-friendly language so that non-expert investors
can easily understand the business reasons behind the move, what could go wrong, and what the risks are.

Empirical Short-Term Price Guidance & Profit Accuracy:
When verified short-term price movement facts or profit accuracy track records from historical bhavcopy data files
are supplied in the prompt, treat this empirical data as ground truth. Candidates that demonstrated verified positive
follow-through and met their profit accuracy threshold with institutional volume represent validated momentum; award
them higher profit probability. Candidates that suffered immediate reversals, failed their profit threshold, or showed
sharp volume drying must be downgraded to low or unsure outlook.`;

export function isPausedMetricSearch(query: string): boolean {
  return /\b(?:P\/?E|price[- ]to[- ]earnings|market\s*cap(?:italization|italisation)?|debt\s*(?:\/|to|-to-)\s*equity|earnings[- ]growth|corporate[- ]actions?|quote\s*(?:timestamp|time)|(?:live|current|latest)\s+(?:(?:stock|share)\s+)?(?:prices?|quotes?)|(?:stock|share)\s+prices?)\b/i.test(query);
}
