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
adjusted prices. Do not claim corporateActionsClear. Do not reuse old cached numerical metrics.`;

export function isPausedMetricSearch(query: string): boolean {
  return /\b(?:P\/?E|price[- ]to[- ]earnings|market\s*cap(?:italization|italisation)?|debt\s*(?:\/|to|-to-)\s*equity|earnings[- ]growth|corporate[- ]actions?|quote\s*(?:timestamp|time)|(?:live|current|latest)\s+(?:(?:stock|share)\s+)?(?:prices?|quotes?)|(?:stock|share)\s+prices?)\b/i.test(query);
}
