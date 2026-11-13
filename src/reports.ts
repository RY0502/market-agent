import type { PricePoint } from './bhav.js';
import type { RankedStock } from './research.js';
import { isTradingViewSource } from './tradingview-source.js';
import { evidenceUrl, researchQuality } from './research-quality.js';

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
    dataGapReason: assessment.dataGapReason && useful(assessment.dataGapReason) ? assessment.dataGapReason.slice(0, 1_200) : '',
    reasons: texts(assessment.reasons), risks: texts(assessment.risks),
    catalysts: texts(assessment.recoveryCatalysts),
    marketContext: useful(assessment.marketContext) ? assessment.marketContext.slice(0, 1_200) : '',
    metrics: fields.flatMap(([field, label]) => {
      const metric = assessment[field];
      const invalid = (assessment.warnings ?? []).some(warning =>
        (warning.field === field || warning.field === `evidenceIds.${field}`) &&
        ['invalid_submission_field', 'uncited_metric', 'numeric_evidence_mismatch', 'unobserved_source', 'missing_context'].includes(warning.code));
      const nse = stock.candidate.nse;
      const scrapeRead = metric?.source && stock.research.reads.find(read =>
        read.kind === 'scrape' && (isTradingViewSource(read.url) || read.url.startsWith('https://www.screener.in/company/')) &&
        read.url === metric.source?.url && read.output === metric.source.excerpt);
      const isTv = Boolean(scrapeRead && isTradingViewSource(scrapeRead.url));
      const isScreener = Boolean(scrapeRead && scrapeRead.url.startsWith('https://www.screener.in/company/'));
      const date = scrapeRead ? scrapeRead.observedAt.slice(0, 10) : nse && (field === 'pe' || field === 'marketCapCrore')
        ? nse[field] ? nse.asOf : nse.historical?.[field]?.asOf
        : undefined;
      return metric && metric.source && Number.isFinite(metric.value) && !invalid
        ? [{ field, label: isTv && field === 'pe' ? 'P/E (TTM)' : label,
          value: metric.value, asOf: date, retrieved: isTv ? 'TradingView' : isScreener ? 'Screener' : undefined, historical: Boolean(!scrapeRead && date && date < stock.candidate.asOfDate) }] : [];
    }),
  };
}

/** Consecutive observations may span missing trading archives. */
export function detectFirstSpikeIndex(prices: PricePoint[]): number | null {
  if (prices.length < 2) return null;
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!.close;
    const curr = prices[i]!.close;
    if (prev > 0 && (curr - prev) / prev >= 0.05) {
      return i;
    }
  }
  return null;
}

/** Closing-price difference across up to five observations, not five return intervals. */
export function fiveDayGain(prices: PricePoint[]): number | null {
  if (prices.length < 2) return null;
  const recent = prices.slice(-5);
  if (recent.length < 2) return null;
  return Math.round((recent.at(-1)!.close - recent[0]!.close) * 100) / 100;
}

function priceChart(prices: PricePoint[], requestedPoints: number): string {
  if (!prices.length) return '<p>No daily closing-price observations are available.</p>';
  const values = prices.map(point => point.close);
  if (values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid report price observation');
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, max * 0.01, 1);
  const bottom = Math.max(0, min - padding);
  const top = max + padding;
  const range = top - bottom || 1;
  const chartWidth = 340;
  const chartLeft = 74;
  const chartHeight = 165;
  const chartBottom = 195;
  const x = (index: number) => prices.length === 1 ? chartLeft + chartWidth / 2 : chartLeft + index * chartWidth / (prices.length - 1);
  const y = (value: number) => chartBottom - (value - bottom) / range * chartHeight;
  const ticks = Array.from({ length: 4 }, (_, index) => {
    const value = bottom + range * index / 3;
    return `<line x1="${chartLeft}" x2="${chartLeft + chartWidth}" y1="${y(value)}" y2="${y(value)}" class="grid"/>
<text x="${chartLeft - 8}" y="${y(value) + 4}" text-anchor="end">${escape(number(value))}</text>`;
  }).join('');
  const trend = values.at(-1)! >= values[0]! ? 'up' : 'down';
  const spikeIndex = detectFirstSpikeIndex(prices);
  let spikeElements = '';
  if (spikeIndex !== null) {
    const spikePt = prices[spikeIndex]!;
    const spikeX = x(spikeIndex);
    const spikeY = y(spikePt.close);
    const textY = spikeY > 35 ? spikeY - 10 : spikeY + 22;
    let textAnchor = 'middle';
    let textX = spikeX;
    if (spikeX > chartLeft + chartWidth - 30) {
      textAnchor = 'end';
      textX = spikeX - 4;
    } else if (spikeX < chartLeft + 30) {
      textAnchor = 'start';
      textX = spikeX + 4;
    }
    spikeElements = `<circle cx="${spikeX}" cy="${spikeY}" r="6" fill="#d9480f" stroke="#ffffff" stroke-width="2"/>
<text x="${textX}" y="${textY}" class="spike-label" text-anchor="${textAnchor}" font-weight="bold" fill="#d9480f" font-size="12">⚡ Spike</text>`;
  }
  const dateLabels = prices.map((point, index) => {
    const xPos = x(index);
    const label = point.date.slice(5).split('-').reverse().join('/');
    // For 10+ points, rotate labels to avoid overlap
    if (prices.length > 6) {
      return `<text x="${xPos}" y="221" text-anchor="end" transform="rotate(-45,${xPos},216)" font-size="10">${escape(label)}</text>`;
    }
    return `<text x="${xPos}" y="221" text-anchor="middle">${escape(label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 460 250" role="img" aria-labelledby="chart-title chart-desc">
<title id="chart-title">Daily closing prices</title><desc id="chart-desc">${escape(prices.map(point => `${point.date}: INR ${number(point.close)}`).join('; '))}</desc>
${ticks}<polyline fill="none" class="line ${trend}" points="${prices.map((point, index) => `${x(index)},${y(point.close)}`).join(' ')}"/>
${prices.map((point, index) => `<circle class="${trend}" cx="${x(index)}" cy="${y(point.close)}" r="4"/>`).join('')}
${spikeElements}
${dateLabels}
</svg><p class="muted">${prices.length} observed trading session${prices.length === 1 ? '' : 's'}${prices.length < requestedPoints ? ` of ${requestedPoints} requested; earlier observations were unavailable within retained history/download limits` : ''}. Missing archives are skipped; actual session dates are shown without interpolation. Points are equally spaced observations, not equal calendar intervals. Linear price axis; the vertical scale does not necessarily start at zero.${spikeIndex !== null ? '<br/><strong style="color:#d9480f;display:inline-block;margin-top:4px">⚡ First ≥5% rise between observed closes in this window; not necessarily one trading day.</strong>' : ''}<br><strong>Note:</strong> This graph and the table use daily closing prices. The separate screen-period change compares endpoint intraday highs (gainers) or lows (losers), not an achievable investment return.</p>`;
}

function priceTable(prices: PricePoint[], gain: number | null): string {
  const recent = prices.slice(-5);
  return `<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
<div class="table-wrap" style="flex:1;min-width:220px"><div class="muted" style="font-weight:600;margin-bottom:6px">Daily closing prices (not live LTP)</div><table><thead><tr><th>Date</th><th>Close (INR)</th></tr></thead><tbody>${prices.map(point =>
    `<tr><td>${escape(point.date)}</td><td>${money(point.close)}</td></tr>`).join('')}</tbody></table></div>
<div style="flex:0 0 200px;background:#f3f6fa;border-radius:8px;padding:14px;text-align:center">
<div class="muted">Closing-price change across ${recent.length} observation${recent.length === 1 ? '' : 's'}</div>
<span class="value" style="color:${gain !== null && gain >= 0 ? '#087f5b' : '#c92a2a'}">${gain !== null ? money(gain) : 'N/A'}</span>
<div class="muted">${recent.length >= 2 ? `${escape(recent[0]!.date)} to ${escape(recent.at(-1)!.date)}; ${recent.length - 1} observed intervals` : 'At least two observations are required'}</div>
</div></div>`;
}

function highPriceChart(prices: PricePoint[]): string {
  const points = prices.filter(p => p.high !== undefined && Number.isFinite(p.high) && p.high! > 0);
  if (!points.length) return '<p>No daily high-price observations are available.</p>';
  const values = points.map(point => point.high!);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, max * 0.01, 1);
  const bottom = Math.max(0, min - padding);
  const top = max + padding;
  const range = top - bottom || 1;
  const chartWidth = 340;
  const chartLeft = 74;
  const chartHeight = 165;
  const chartBottom = 195;
  const x = (index: number) => points.length === 1 ? chartLeft + chartWidth / 2 : chartLeft + index * chartWidth / (points.length - 1);
  const y = (value: number) => chartBottom - (value - bottom) / range * chartHeight;
  const ticks = Array.from({ length: 4 }, (_, index) => {
    const value = bottom + range * index / 3;
    return `<line x1="${chartLeft}" x2="${chartLeft + chartWidth}" y1="${y(value)}" y2="${y(value)}" class="grid"/>
<text x="${chartLeft - 8}" y="${y(value) + 4}" text-anchor="end">${escape(number(value))}</text>`;
  }).join('');
  const trend = values.at(-1)! >= values[0]! ? 'up' : 'down';
  const dateLabels = points.map((point, index) => {
    const xPos = x(index);
    const label = point.date.slice(5).split('-').reverse().join('/');
    return `<text x="${xPos}" y="221" text-anchor="middle">${escape(label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 460 250" role="img" aria-labelledby="high-chart-title high-chart-desc">
<title id="high-chart-title">Daily high prices (${points.length} observations)</title><desc id="high-chart-desc">${escape(points.map(point => `${point.date}: INR ${number(point.high!)}`).join('; '))}</desc>
${ticks}<polyline fill="none" class="line ${trend}" points="${points.map((point, index) => `${x(index)},${y(point.high!)}`).join(' ')}"/>
${points.map((point, index) => `<circle class="${trend}" cx="${x(index)}" cy="${y(point.high!)}" r="4"/>`).join('')}
${dateLabels}
</svg><p class="muted">${points.length} observed trading session${points.length === 1 ? '' : 's'}. Intraday highs are not closing prices or guaranteed execution prices. This recent window may differ from the screening window. Linear price axis; observations are equally spaced.</p>`;
}

function highTable(prices: PricePoint[]): string {
  const points = prices.filter(p => p.high !== undefined && Number.isFinite(p.high) && p.high! > 0);
  if (!points.length) return '';
  const gain = points.length >= 2
    ? Math.round((points.at(-1)!.high! - points[0]!.high!) * 100) / 100
    : null;
  return `<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
<div class="table-wrap" style="flex:1;min-width:220px"><div class="muted" style="font-weight:600;margin-bottom:6px">Daily high prices list (last ${points.length} session${points.length === 1 ? '' : 's'})</div><table><thead><tr><th>Date</th><th>Day High (INR)</th></tr></thead><tbody>${points.map(point =>
    `<tr><td>${escape(point.date)}</td><td>${money(point.high!)}</td></tr>`).join('')}</tbody></table></div>
<div style="flex:0 0 200px;background:#f3f6fa;border-radius:8px;padding:14px;text-align:center">
<div class="muted">High-price change across ${points.length} observation${points.length === 1 ? '' : 's'}</div>
<span class="value" style="color:${gain !== null && gain >= 0 ? '#087f5b' : '#c92a2a'}">${gain !== null ? money(gain) : 'N/A'}</span>
<div class="muted">${points.length >= 2 ? `${escape(points[0]!.date)} to ${escape(points.at(-1)!.date)}; not a realised return` : 'At least two observations are required'}</div>
</div></div>`;
}

function financialContextGuide(stock: RankedStock, reasoning: ReturnType<typeof reportReasoning>): string {
  const nse = stock.candidate.nse;
  const adjustedPe = nse?.adjustedPe;
  const assessment = stock.research.assessment;

  const allTexts = [
    assessment.classificationReason,
    ...(assessment.reasons ?? []),
    ...(assessment.risks ?? []),
    ...(assessment.recoveryCatalysts ?? []),
    assessment.marketContext,
  ].filter(Boolean).join(' ');

  const hasPeMetric = reasoning.metrics.some(m => /p\/e/i.test(m.label)) || adjustedPe != null;
  const mentionsPe = hasPeMetric || /\bp\/?e\b|price[- ]to[- ]earnings/i.test(allTexts);

  const hasMcapMetric = reasoning.metrics.some(m => /market cap/i.test(m.label));
  const mentionsMcap = hasMcapMetric || /market cap|capitalization|large[- ]cap|mid[- ]cap|small[- ]cap/i.test(allTexts);

  const mentionsValuation = mentionsPe || /valu(?:ation|ed)|overvalued|undervalued|expensive multiple|premium multiple/i.test(allTexts);

  const hasDebtMetric = reasoning.metrics.some(m => /debt/i.test(m.label));
  const mentionsDebt = hasDebtMetric || /debt[- ]to[- ]equity|leverage|indebtedness/i.test(allTexts);

  const items: string[] = [];

  if (mentionsPe) {
    items.push(`<li><strong>P/E (Price-to-Earnings) Ratio:</strong> Measures how much investors pay per &#8377;1 of reported annual company earnings for the stated period.
      Compare only matching earnings periods and accounting bases in similar businesses. A high or low ratio alone does not establish cheapness, safety or next-week returns. Missing P/E does not prove losses.</li>`);
  }

  if (mentionsValuation) {
    items.push(`<li><strong>Valuation &amp; Overvaluation:</strong> Price must be assessed against comparable business earnings, assets and expectations. This report does not establish a fair value or margin of safety merely from P/E.</li>`);
  }

  if (mentionsMcap) {
    items.push(`<li><strong>Market Capitalization (Company Size):</strong> Total market value of outstanding shares in INR crore. It measures size, not how cheap a share is. Size alone does not establish balance-sheet strength, trading liquidity, low volatility or safety.</li>`);
  }

  if (mentionsDebt) {
    items.push(`<li><strong>Debt-to-Equity (D/E):</strong> Compares borrowing with shareholders' equity. Interpretation depends on industry, cash flows and accounting basis; no universal cutoff establishes safety. This metric is currently paused.</li>`);
  }

  if (!items.length) return '';

  return `<div style="margin-top:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
<div class="muted" style="font-weight:650;color:#334155;margin-bottom:8px">Understanding these fundamentals (investor guide):</div>
<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;color:#475569">${items.join('')}</ul>
</div>`;
}

export function decisionBrief(stock: RankedStock, now = Date.now()) {
  const reasoning = reportReasoning(stock);
  const candidate = stock.candidate;
  const signals = candidate.priceSignals;
  const spike = signals?.latestSpike;
  const quality = researchQuality(stock, now);
  const whatHappened = signals
    ? `Closing prices changed ${number(signals.closeChangePercent)}% from ${signals.startDate} to ${signals.endDate} across ${signals.observations} observations.`
    : `The stock passed the price/movement screen using the bhavcopy close dated ${candidate.asOfDate}; detailed continuation signals are unavailable.`;
  const whyItMatters = spike
    ? `The latest rise of at least 5% was between observed closes on ${spike.fromDate} and ${spike.date}. ${spike.observationsSince} later observations are available; the close has changed ${number(spike.moveSincePercent)}% since that rise.${spike.volumeRatioToPrior !== null ? ` Volume on that observation was ${number(spike.volumeRatioToPrior)} times the preceding average.` : ''}${spike.subsequentVolumeRatioToPrior !== null ? ` Later average volume was ${number(spike.subsequentVolumeRatioToPrior)} times that same pre-rise average.` : ''} This does not establish the cause or predict continuation.`
    : 'Past price strength alone does not show why the move happened or establish that it will continue next week.';
  return {
    quality, whatHappened, whyItMatters,
    support: reasoning.reasons.slice(0, 2),
    risks: [
      ...reasoning.risks.slice(0, 2),
      ...(signals ? [`The close is ${number(signals.pullbackFromPeakPercent)}% below the highest observed close; the largest peak-to-later-close fall in this window was ${number(signals.maximumDrawdownPercent)}%. These historical declines do not bound future losses.`] : []),
    ],
    changes: reasoning.catalysts.length ? reasoning.catalysts.slice(0, 2)
      : ['New verified company disclosures, sustained trading participation or a loss of recent price strength would require a fresh assessment; no specific business trigger was established.'],
  };
}

function renderDecisionBrief(stock: RankedStock, now: number): string {
  const brief = decisionBrief(stock, now);
  const reasoning = reportReasoning(stock);
  const outlook = { high: 'Favourable case', medium: 'Mixed case', low: 'Weak upside / downside concerns' };
  const category = stock.research.assessment.profitProbability;
  const item = (label: string, text: string) => `<p><strong>${label}:</strong> ${escape(text)}</p>`;
  const pe = reasoning.metrics.find(metric => metric.field === 'pe' && metric.value > 0);
  const cap = reasoning.metrics.find(metric => metric.field === 'marketCapCrore');
  const meaningful = stock.research.assessment.warnings?.some(warning => warning.code === 'pe_not_meaningful') &&
    stock.research.reads.some(read => read.kind === 'scrape' && isTradingViewSource(read.url));
  const gaps = [...brief.quality.gaps];
  if (!stock.research.failure && stock.research.assessment.profitProbability === null) {
    const gap = reasoning.dataGapReason || reasoning.classificationReason;
    gaps.push(gap || 'Available evidence does not establish a clear next-week direction.');
  }
  return `<section><h2>Decision brief</h2>
${item('Next-week outlook', category ? outlook[category] : 'Unsure')}
${item('Evidence confidence', `${brief.quality.confidence}. ${brief.quality.freshSources} distinct cited recent business sources across ${brief.quality.freshDomains} domains. This is coverage, not an accuracy score or a guarantee of independent reporting.`)}
${item('What happened', brief.whatHappened)}
${item('Why it matters', brief.whyItMatters)}
${item('What supports the view', brief.support.join(' ') || 'No supported business explanation is available.')}
${item('What could go wrong', brief.risks.join(' ') || 'Downside risk could not be assessed; this is not evidence of low risk.')}
${pe ? item('P/E in everyday terms', `Investors paid about Rs ${number(pe.value)} per Rs 1 of reported annual earnings on this basis.${pe.asOf ? ` ${pe.historical ? 'Last available historical NSE observation' : pe.retrieved ? `${pe.retrieved} retrieved (not the financial reporting date)` : 'Observation date'}: ${pe.asOf}.` : ''} This is not a payback promise or proof that the share is cheap.`)
    : meaningful ? item('P/E limitation', 'The captured TradingView page displays negative TTM earnings per share. A conventional positive P/E comparison is not meaningful on that basis; other periods may differ.')
      : item('P/E limitation', 'A usable ratio is unavailable. That does not establish whether the company is profitable or loss-making.')}
${cap ? item('Company size', `Reported market cap: Rs ${number(cap.value)} crore${cap.asOf ? ` (${cap.historical ? 'historical observation' : cap.retrieved ? 'page retrieved' : 'as of'} ${cap.asOf})` : ''}. This measures company size, not cheapness or safety.`) : ''}
${item('What is missing or uncertain', [...new Set(gaps)].join(' ') || 'No additional coverage gaps were identified; uncertainty and investment risk remain.')}
${item('What would change the view', brief.changes.join(' '))}
<p class="muted">Outlook is the model's interpretation, evidence confidence describes support, and downside risk describes possible losses. They are different concepts. No benchmark-relative performance comparison is supplied.</p></section>`;
}

function reportSources(stock: RankedStock): string {
  const seen = new Set<string>();
  const sources = [stock.research.assessment.marketEvidence, ...stock.research.assessment.sources,
    ...reportReasoning(stock).metrics.flatMap(metric => {
      const source = stock.research.assessment[metric.field]?.source;
      return source ? [source] : [];
    })].filter(source => source !== null).flatMap(source => {
      const url = new URL(source.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
      const key = evidenceUrl(source.url);
      const read = stock.research.reads.find(read => read.url === source.url &&
        read.output.replace(/\s+/g, ' ').includes(source.excerpt.replace(/\s+/g, ' ')));
      if (!read || seen.has(key)) return [];
      seen.add(key);
      return [`<li><a href="${escape(source.url)}" rel="noopener noreferrer">${escape(url.hostname)}</a>${read.publishedAt ? `; published ${escape(read.publishedAt)}` : '; publication date not established'}; retrieved ${escape(read.observedAt)}${read.cachedAt ? '; reused dated background' : ''}</li>`];
    }).slice(0, 20);
  return sources.length ? `<section><h2>Captured sources</h2><ul>${sources.join('')}</ul><p class="muted">Source presence is not independent verification. Publication dates differ from retrieval dates.</p></section>` : '';
}

/** Render the public stock report without the detailed P/E history table. */
export function renderStockReport(
  stock: RankedStock, runId: string, prices: PricePoint[], requestedPoints: number, createdAt: string, expiresAt: string,
): string {
  if (!Number.isInteger(requestedPoints) || requestedPoints < 1 || requestedPoints > 10 || prices.length > requestedPoints) {
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
  const adjustedPe = nse?.adjustedPe ?? nse?.historical?.adjustedPe?.value;
  const adjustedPeDate = nse?.adjustedPe != null ? nse.asOf : nse?.historical?.adjustedPe?.asOf;
  const gain = fiveDayGain(ordered);
  const rankDisplay = stock.totalPassing ? `${stock.rank} of ${stock.totalPassing}` : `${stock.rank}`;
  const fundamentalGuide = financialContextGuide(stock, reasoning);
  const fortified = candidate.insightFortified ?? (assessment as any)?.insightFortified ?? 0;
  const insightText = candidate.insightText ?? (assessment as any)?.insightText;
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
.spike-label{font:bold 13px system-ui,sans-serif}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e5eaf0;white-space:nowrap}.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
header,section,footer{overflow-wrap:anywhere}footer{padding:0 8px 20px}
</style></head><body><main>
<header><span class="badge">${escape(candidate.group)}</span> <span class="badge">Rank #${escape(rankDisplay)}</span>${fortified > 0 ? ` <span class="badge" style="background:#e6fcf5;color:#0ca678;border:1px solid #20c997;font-weight:600">Insight Backed (Fortified: ${escape(String(fortified))}x)</span>` : ''}<h1>${escape(candidate.symbol)}</h1><p>${escape(candidate.name)}</p>
<div class="cards"><div class="card">Screen rank<span class="value">#${escape(rankDisplay)}</span><span class="muted">${stock.totalPassing ? `Top ${stock.rank} of ${stock.totalPassing} passing` : 'Rank among screened'}</span></div>
<div class="card">Bhavcopy close<span class="value">${money(candidate.price)}</span><span class="muted">As of ${escape(candidate.asOfDate)}</span></div>
<div class="card">Next-week outlook<span class="value">${escape(category)}</span></div>
<div class="card">Screen-period change<span class="value">${money(candidate.change)}</span>${escape(number(candidate.changePercent))}% (${escape(candidate.baselineDate)} to ${escape(candidate.asOfDate)})<span class="muted" style="display:block;margin-top:2px">${candidate.group === 'gainers' ? 'Gain between high to highs in the period' : 'Movement between low to lows in the period'}</span></div></div>
<p class="muted">Rank by past price movement, not safety, evidence confidence or expected return. An intraday high-to-high comparison is not a realised investment return.</p>
<p class="badge">${escape(cacheText)}</p>${cache?.backgroundResearchedAt ? `<p class="muted">Background researched: ${escape(cache.backgroundResearchedAt)}</p>` : ''}
<p class="muted">Assessment recorded: ${escape(stock.research.researchedAt)}</p>${stock.research.failure
    ? stock.research.reads.some(read => read.kind === 'scrape' && isTradingViewSource(read.url))
      ? '<p>Initial research was unavailable; review the assessment and its limitations carefully.</p>'
      : '<p>Research was unavailable for this assessment. No investment outlook was produced.</p>'
    : ''}</header>
${renderDecisionBrief(stock, Date.parse(createdAt))}
<section><h2>Recent price performance</h2><p class="muted">Daily NSE bhavcopy closing prices, not intraday/live quotes. Prices are unadjusted for corporate actions. The closing-price graph is separate from the endpoint high-to-high screening calculation.</p>${priceChart(ordered, requestedPoints)}
${priceTable(ordered, gain)}</section>
${ordered.some(point => point.high !== undefined) ? `<section><h2>Daily high price performance (up to 5 observations)</h2><p class="muted">Peak intraday high prices from up to five recent NSE bhavcopy observations, not the full screening window.</p>${highPriceChart(ordered.slice(-5))}
${highTable(ordered.slice(-5))}</section>` : ''}
${section('Investment outlook', reasoning.classificationReason)}
${list('Supporting considerations', reasoning.reasons)}${list('Business and investment risks', reasoning.risks)}
${list('Potential catalysts', reasoning.catalysts)}${section('Market context', reasoning.marketContext)}
${fortified > 0 && insightText ? `<section><h2>Market Insight &amp; Historical Pattern</h2><p><strong>Fortified ${escape(String(fortified))}x:</strong> ${escape(insightText)}</p><p class="muted">This observation was derived from historical prediction performance and verified across prior market runs.</p></section>` : ''}
${reasoning.metrics.length || adjustedPe != null ? `<section><h2>Available financial context</h2><p class="muted">Dated reported figures${!nse && assessment.financialPeriod ? `: ${escape(assessment.financialPeriod.slice(0, 100))}` : ''}; not live financial statements. Historical values may not reflect the analysis date's valuation.</p><div class="cards">${reasoning.metrics.map(metric =>
    `<div class="card">${metric.label}<span class="value">${escape(number(metric.value))}</span>${metric.asOf ? `<span class="muted">${metric.retrieved ? `${metric.retrieved} retrieved` : metric.historical ? 'Historical context' : 'As of'}: ${escape(metric.asOf)}</span>` : ''}</div>`).join('')}
${adjustedPe != null && adjustedPeDate ? `<div class="card">Adjusted P/E (distinct NSE figure)<span class="value">${escape(number(adjustedPe))}</span><span class="muted">${adjustedPeDate < candidate.asOfDate ? 'Historical context' : 'As of'}: ${escape(adjustedPeDate)}</span></div>` : ''}</div>${fundamentalGuide}</section>` : (fundamentalGuide ? `<section><h2>Financial fundamentals guide</h2>${fundamentalGuide}</section>` : '')}
${nse?.corporateActions.length ? list('NSE corporate-action notices', nse.corporateActions.map(action =>
    `${action.purpose}; ${action.exDate ? `ex-date ${action.exDate}` : `record/book date ${action.recordDate ?? action.bookStart ?? 'not supplied'}`}; reported ${action.reportedOn}`)) : ''}
${reportSources(stock)}
<footer><p>Qualitative research, not a calibrated probability or guarantee of returns. Review source filings and current market information before investing. Technical extraction diagnostics are retained in the run audit, not displayed here.</p>
<p>Run: ${escape(runId)}<br>Report created: ${escape(createdAt)}<br>Report expires: ${escape(expiresAt)}. Hosted access ends at expiry and Cloudflare KV automatically removes the stored report. Downloaded copies cannot be recalled.</p></footer>
</main></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > 64_000) throw new Error('Stock report exceeds its 64 KB size limit');
  return html;
}
