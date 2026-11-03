import type { RankedStock, ResearchResult, LiveRead } from './research.js';
import { metricOccursInText } from './financial-metrics.js';

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

export function evidenceUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.toString().replace(/\/$/, '');
}

/** Search providers and identical reprints do not constitute independent confirmation. */
export function distinctBusinessReads(reads: LiveRead[]): LiveRead[] {
  const urls = new Set<string>();
  const texts = new Set<string>();
  return reads.filter(read => {
    if (read.kind === 'nse' || read.kind === 'scrape' || read.output.trim().length < 40) return false;
    const url = evidenceUrl(read.url);
    const text = normalized(read.output);
    if (urls.has(url) || texts.has(text)) return false;
    urls.add(url);
    texts.add(text);
    return true;
  });
}

export function freshBusinessReads(reads: LiveRead[], now = Date.now()): LiveRead[] {
  return distinctBusinessReads(reads).filter(read => {
    const age = now - Date.parse(read.publishedAt ?? '');
    const observedAge = now - Date.parse(read.observedAt);
    return !read.cachedAt && Number.isFinite(age) && age >= -300_000 && age <= 7 * 86_400_000 &&
      Number.isFinite(observedAge) && observedAge >= -300_000 && observedAge <= 3_600_000;
  });
}

export function businessDomains(reads: LiveRead[]): number {
  return new Set(reads.map(read => new URL(read.url).hostname.replace(/^www\./, ''))).size;
}

export function businessEvidenceGaps(result: ResearchResult, now = Date.now()): string[] {
  if (result.failure || result.assessment.warnings?.some(warning =>
    ['research_failed', 'invalid_submission_field', 'identity_mismatch'].includes(warning.code))) return [];
  const gaps: string[] = [];
  const fresh = freshBusinessReads(result.reads, now);
  if (!fresh.length) gaps.push('No captured company/business source has a verified publication date within the last seven days.');
  else if (businessDomains(fresh) < 2) gaps.push('Recent business coverage is limited to one source domain after duplicate removal.');
  if (result.assessment.warnings?.some(warning =>
    ['historical_nse_claim_mismatch', 'numeric_evidence_mismatch', 'unobserved_source'].includes(warning.code))) {
    gaps.push('A claim or source could not be corroborated; additional business evidence may help clarify the view.');
  }
  return gaps;
}

/** Application-owned coverage, kept separate from the model's directional outlook and risk scores. */
export function researchQuality(stock: RankedStock, now = Date.now()) {
  const { assessment, reads, failure } = stock.research;
  const gaps: string[] = [];
  const cited = [assessment.marketEvidence, ...assessment.sources].filter(source => source !== null);
  const supported = reads.filter(read => cited.some(source => source.url === read.url &&
    normalized(read.output).includes(normalized(source.excerpt))));
  const fresh = freshBusinessReads(supported, now);
  const freshDomains = businessDomains(fresh);
  let verifiedMetrics = 0;
  let historicalMetrics = 0;
  if (failure) gaps.push('Business research could not be completed; this is an execution failure, not evidence against the company.');
  if (!fresh.length) gaps.push('No cited business source has a verified recent publication date; retrieved pages are not necessarily new news.');
  else if (freshDomains < 2) gaps.push('Recent cited business evidence comes from one source domain; independent corroboration is limited.');
  for (const [field, label] of [['pe', 'P/E'], ['marketCapCrore', 'Company size (market cap)']] as const) {
    if (!assessment[field]) gaps.push(`${label} is unavailable. Missing data is not zero or proof of financial weakness.`);
    else if (!assessment[field]?.source || assessment.warnings?.some(warning =>
      warning.field.replace(/^evidenceIds\./, '') === field &&
      ['uncited_metric', 'numeric_evidence_mismatch', 'unobserved_source', 'invalid_submission_field'].includes(warning.code))) {
      gaps.push(`${label} could not be verified against captured evidence.`);
    } else {
      const metric = assessment[field]!;
      if (!reads.some(read => read.url === metric.source?.url &&
        normalized(read.output).includes(normalized(metric.source.excerpt))) ||
        !metricOccursInText(field, metric.value, metric.source!.excerpt)) {
        gaps.push(`${label} could not be verified against captured evidence.`);
        continue;
      }
      verifiedMetrics++;
      if (stock.candidate.nse?.historical?.[field] && !stock.candidate.nse[field] &&
        metric.source?.url === stock.candidate.nse.historical[field]?.source.url) {
        historicalMetrics++;
        gaps.push(`${label} uses an older NSE observation dated ${stock.candidate.nse.historical[field]!.asOf}, not a current valuation.`);
      }
    }
  }
  if (!assessment.corporateActionsClear) gaps.push('Prices are unadjusted; available notices do not prove that corporate actions had no effect.');
  const signals = stock.candidate.priceSignals;
  if (signals && (signals.missingArchiveDates.length || signals.missingStockObservations)) {
    gaps.push('The price history has missing archives or stock observations; measured intervals may span multiple sessions.');
  }
  const disputed = assessment.warnings?.some(warning =>
    ['historical_nse_claim_mismatch', 'numeric_evidence_mismatch', 'unobserved_source', 'invalid_submission_field',
      'identity_mismatch', 'research_failed', 'stale_evidence', 'publication_date_unverified'].includes(warning.code));
  if (disputed && !failure) gaps.push('Some claims could not be verified or some decision fields were unusable; treat the interpretation cautiously.');
  const confidence = failure || !supported.some(read => read.kind !== 'nse' && read.output.trim().length >= 40)
    ? 'Insufficient' : freshDomains >= 2 && !disputed && verifiedMetrics === 2 && !historicalMetrics
      ? 'Stronger' : 'Limited';
  return { confidence, freshSources: fresh.length, freshDomains, gaps };
}
