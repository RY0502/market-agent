import type { PricePoint } from './bhav.js';
import type { RankedStock } from './research.js';
import { isTradingViewSource } from './tradingview-source.js';

export interface ReportReference {
  url: string;
  expiresAt: string;
}

export type Reporter = (
  stock: RankedStock, runId: string, prices: PricePoint[], requestedPoints: number,
) => Promise<ReportReference>;

const escape = (text: string) => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);
const number = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const money = (value: number) => `&#8377;${number(value)}`;

/** Select supported narrative and financial context for the public report. */
export function reportReasoning(stock: RankedStock) {
  const assessment = stock.research.assessment;
  const warnings = new Set((assessment.warnings ?? []).map(warning => warning.message));
  const useful = (text: string) => Boolean(text.trim()) && !warnings.has(text) &&
    !/^(?:Background research from .* is reused;|Only bhavcopy pricing is available after this research failure:|Business\/news research failed;|Research could not be completed for this stock:|Unsure: research did not complete successfully|Unsure: no usable research evidence was captured)/.test(text) &&
    !/^(?:Available research is insufficient for a supported outlook|Current quote and corporate actions remain unverified|Current market context could not be independently verified)\.?$/.test(text) &&
    !/(?:unusable model field|unusable decision fields|missing or unusable decision fields|model submission|correction round|evidenceIds\.|retained usable fields without|No captured research evidence)/i.test(text);
  const texts = (items: string[]) => [...new Set(items.filter(useful))].slice(0, 8).map(text => text.slice(0, 900));
  const fields = [
    ['pe', 'P/E'], ['sectorPe', 'Sector P/E'], ['marketCapCrore', 'Market cap (INR crore)'],
    ['debtToEquity', 'Debt / equity'], ['earningsGrowthPercent', 'Earnings growth (%)'],
  ] as const;
  return {
    classificationReason: useful(assessment.classificationReason) ? assessment.classificationReason.slice(0, 2_000) : '',
    reasons: texts(assessment.reasons), risks: texts(assessment.risks),
    catalysts: texts(assessment.recoveryCatalysts),
    marketContext: useful(assessment.marketContext) ? assessment.marketContext.slice(0, 1_200) : '',
    metrics: fields.flatMap(([field, label]) => {
      const metric = assessment[field];
      const invalid = (assessment.warnings ?? []).some(warning =>
        (warning.field === field || warning.field === `evidenceIds.${field}`) &&
        ['invalid_submission_field', 'uncited_metric', 'numeric_evidence_mismatch', 'unobserved_source', 'missing_context'].includes(warning.code));
      const nse = stock.candidate.nse;
      const tradingViewRead = metric?.source && stock.research.reads.find(read =>
        read.kind === 'scrape' && isTradingViewSource(read.url) &&
        read.url === metric.source?.url && read.output === metric.source.excerpt);
      const date = tradingViewRead ? tradingViewRead.observedAt.slice(0, 10) : nse && (field === 'pe' || field === 'marketCapCrore')
        ? nse[field] ? nse.asOf : nse.historical?.[field]?.asOf
        : undefined;
      if (field === 'pe' && nse && !nse.pe && !tradingViewRead) return [];
      return metric && metric.source && Number.isFinite(metric.value) && !invalid
        ? [{ label: tradingViewRead && field === 'pe' ? 'P/E (TTM)' : label,
          value: metric.value, asOf: date, retrieved: Boolean(tradingViewRead), historical: Boolean(!tradingViewRead && date && date < stock.candidate.asOfDate) }] : [];
    }),
  };
}

function priceChart(prices: PricePoint[], requestedPoints: number): string {
  if (!prices.length) return '<p>No daily closing-price observations are available.</p>';
  const values = prices.map(point => point.close);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid report price observation');
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, max * 0.01, 1);
  const bottom = min - padding;
  const top = max + padding;
  const x = (index: number) => prices.length === 1 ? 230 : 74 + index * 300 / (prices.length - 1);
  const y = (value: number) => 195 - (value - bottom) / (top - bottom) * 165;
  const ticks = Array.from({ length: 4 }, (_, index) => {
    const value = bottom + (top - bottom) * index / 3;
    return `<line x1="74" x2="374" y1="${y(value)}" y2="${y(value)}" class="grid"/>
<text x="66" y="${y(value) + 4}" text-anchor="end">${escape(number(value))}</text>`;
  }).join('');
  const trend = values.at(-1)! >= values[0]! ? 'up' : 'down';
  return `<svg viewBox="0 0 400 235" role="img" aria-labelledby="chart-title chart-desc">
<title id="chart-title">Daily closing prices</title><desc id="chart-desc">${escape(prices.map(point => `${point.date}: INR ${number(point.close)}`).join('; '))}</desc>
${ticks}<polyline fill="none" class="line ${trend}" points="${prices.map((point, index) => `${x(index)},${y(point.close)}`).join(' ')}"/>
${prices.map((point, index) => `<circle class="${trend}" cx="${x(index)}" cy="${y(point.close)}" r="4"/>
<text x="${x(index)}" y="221" text-anchor="middle">${escape(point.date.slice(5).split('-').reverse().join('/'))}</text>`).join('')}
</svg><p class="muted">${prices.length} observed trading session${prices.length === 1 ? '' : 's'}${prices.length < requestedPoints ? ` of ${requestedPoints} requested; earlier observations were unavailable within retained history/download limits` : ''}. Missing archives are skipped; actual session dates are shown without interpolation.</p>
<div class="table-wrap"><table><thead><tr><th>Date</th><th>Close (INR)</th></tr></thead><tbody>${prices.map(point =>
    `<tr><td>${escape(point.date)}</td><td>${money(point.close)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** Render the public stock report without the detailed P/E history. */
export function renderStockReport(
  stock: RankedStock, runId: string, prices: PricePoint[], requestedPoints: number, createdAt: string, expiresAt: string,
): string {
  if (!Number.isInteger(requestedPoints) || requestedPoints < 1 || requestedPoints > 5 || prices.length > requestedPoints) {
    throw new Error('Invalid report chart length');
  }
  const ordered = [...prices].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(ordered.map(point => point.date)).size !== ordered.length ||
    ordered.some(point => point.date > stock.candidate.asOfDate)) throw new Error('Invalid report chart dates');
  const reasoning = reportReasoning(stock);
  const assessment = stock.research.assessment;
  const candidate = stock.candidate;
  const section = (heading: string, text: string) => text ? `<section><h2>${heading}</h2><p>${escape(text)}</p></section>` : '';
  const list = (heading: string, items: string[]) => items.length
    ? `<section><h2>${heading}</h2><ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>` : '';
  const cache = stock.research.cache;
  const cacheText = cache?.hit
    ? stock.research.failure ? 'Cached background found; research refresh unavailable' : 'Cached background reused; outlook refreshed'
    : stock.research.failure ? 'No background cache reused; research unavailable' : 'Fresh research (no background cache reused)';
  const category = assessment.profitProbability ?? 'Unsure';
  const nse = candidate.nse;
  const adjustedPe = nse?.adjustedPe;
  const adjustedPeDate = adjustedPe != null ? nse?.asOf : undefined;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(candidate.symbol)} stock research</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#182433;font:16px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:auto;padding:20px 14px}header,section{background:white;border:1px solid #dfe5ec;border-radius:14px;padding:20px;margin-bottom:16px}
h1{font-size:clamp(24px,6vw,34px);line-height:1.2;margin:8px 0}h2{font-size:20px;margin:0 0 12px}p{margin:8px 0}li{margin:8px 0}ul{padding-left:22px}
.muted,footer{color:#536174;font-size:13px}.badge{display:inline-block;background:#eaf0f8;border-radius:8px;padding:4px 10px;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.card{padding:10px;background:#f3f6fa;border-radius:8px}.value{display:block;font-size:22px;font-weight:650}
svg{display:block;width:100%;height:auto;max-width:720px;margin:auto}svg text{font:12px system-ui,sans-serif;fill:#536174}.grid{stroke:#e5eaf0}.line{stroke-width:3}.up{stroke:#087f5b;fill:#087f5b}.down{stroke:#c92a2a;fill:#c92a2a}.line{fill:none}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px;border-bottom:1px solid #e5eaf0}.table-wrap{overflow-x:auto}
header,section,footer{overflow-wrap:anywhere}footer{padding:0 8px 20px}
</style></head><body><main>
<header><span class="badge">${escape(candidate.group)}</span><h1>${escape(candidate.symbol)}</h1><p>${escape(candidate.name)}</p>
<div class="cards"><div class="card">Bhavcopy close<span class="value">${money(candidate.price)}</span><span class="muted">As of ${escape(candidate.asOfDate)}</span></div>
<div class="card">Next-week outlook<span class="value">${escape(category)}</span></div>
<div class="card">Screen-period change<span class="value">${money(candidate.change)}</span>${escape(number(candidate.changePercent))}% (${escape(candidate.baselineDate)} to ${escape(candidate.asOfDate)})</div></div>
<p class="badge">${escape(cacheText)}</p>${cache?.backgroundResearchedAt ? `<p class="muted">Background researched: ${escape(cache.backgroundResearchedAt)}</p>` : ''}
<p class="muted">Assessment recorded: ${escape(stock.research.researchedAt)}</p>${stock.research.failure
    ? stock.research.reads.some(read => read.kind === 'scrape' && isTradingViewSource(read.url))
      ? '<p>Initial research was unavailable; review the assessment and its limitations carefully.</p>'
      : '<p>Research was unavailable for this assessment. No investment outlook was produced.</p>'
    : ''}</header>
<section><h2>Recent price performance</h2><p class="muted">Daily NSE bhavcopy closing prices, not intraday/live quotes. Prices are unadjusted for corporate actions.</p>${priceChart(ordered, requestedPoints)}</section>
${section('Investment outlook', reasoning.classificationReason)}
${list('Supporting considerations', reasoning.reasons)}${list('Business and investment risks', reasoning.risks)}
${list('Potential catalysts', reasoning.catalysts)}${section('Market context', reasoning.marketContext)}
${reasoning.metrics.length || adjustedPe != null ? `<section><h2>Available financial context</h2><p class="muted">Dated reported figures${!nse && assessment.financialPeriod ? `: ${escape(assessment.financialPeriod.slice(0, 100))}` : ''}; not live financial statements. Historical values may not reflect the analysis date's valuation.</p><div class="cards">${reasoning.metrics.map(metric =>
    `<div class="card">${metric.label}<span class="value">${escape(number(metric.value))}</span>${metric.asOf ? `<span class="muted">${metric.retrieved ? 'TradingView retrieved' : metric.historical ? 'Historical context' : 'As of'}: ${escape(metric.asOf)}</span>` : ''}</div>`).join('')}
${adjustedPe != null && adjustedPeDate ? `<div class="card">Adjusted P/E (distinct NSE figure)<span class="value">${escape(number(adjustedPe))}</span><span class="muted">${adjustedPeDate < candidate.asOfDate ? 'Historical context' : 'As of'}: ${escape(adjustedPeDate)}</span></div>` : ''}</div></section>` : ''}
${nse?.corporateActions.length ? list('NSE corporate-action notices', nse.corporateActions.map(action =>
    `${action.purpose}; ${action.exDate ? `ex-date ${action.exDate}` : `record/book date ${action.recordDate ?? action.bookStart ?? 'not supplied'}`}; reported ${action.reportedOn}`)) : ''}
<footer><p>Qualitative research, not a calibrated probability or guarantee of returns. Review source filings and current market information before investing. Technical extraction diagnostics are retained in the run audit, not displayed here.</p>
<p>Run: ${escape(runId)}<br>Report created: ${escape(createdAt)}<br>Report expires: ${escape(expiresAt)}. Hosted access ends at expiry and Cloudflare KV automatically removes the stored report. Downloaded copies cannot be recalled.</p></footer>
</main></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > 64_000) throw new Error('Stock report exceeds its 64 KB size limit');
  return html;
}
