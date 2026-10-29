import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, readOptional } from './storage.js';
import { assessmentSchema, validateAssessment, unsureResearch, applyNseFundamentals, type Researcher, type ResearchResult } from './research.js';

const cacheSchema = z.object({
  version: z.literal(1),
  isin: z.string().regex(/^IN[A-Z0-9]{10}$/),
  symbol: z.string(),
  baselineDate: z.string().date(),
  asOfDate: z.string().date(),
  result: z.object({
    assessment: assessmentSchema,
    researchedAt: z.string().datetime({ offset: true }),
    reads: z.array(z.object({
      url: z.string().url(), output: z.string(), observedAt: z.string().datetime({ offset: true }),
      kind: z.enum(['tavily', 'scrape', 'nse']).optional(),
      publishedAt: z.string().optional(), newsDays: z.number().optional(),
    })),
  }),
}).refine(record => record.baselineDate < record.asOfDate, 'Research cache comparison window is invalid');

export function withResearchCache(
  root: string, lookbackDays: number, runId: string, researcher: Researcher, now: () => number = Date.now,
): Researcher {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays <= 0) throw new Error('Invalid research cache lookback');
  return async candidate => {
    const isin = z.string().regex(/^IN[A-Z0-9]{10}$/).parse(candidate.isin);
    const file = path.join(root, 'research-cache', `${isin}.json`);
    const stored = await readOptional(file);
    let cached: Parameters<Researcher>[1];
    if (stored) {
      const record = cacheSchema.parse(JSON.parse(stored.toString('utf8')));
      if (record.isin !== isin || record.symbol !== record.result.assessment.symbol) {
        throw new Error('Research cache stock identity mismatch');
      }
      const researchedAt = Date.parse(record.result.researchedAt);
      const until = researchedAt + lookbackDays / 2 * 86_400_000;
      if (researchedAt > now()) throw new Error('Research cache timestamp is in the future');
      if (now() < until && record.symbol === candidate.symbol && record.result.reads.length) {
        cached = {
          result: record.result, baselineDate: record.baselineDate, asOfDate: record.asOfDate,
          validUntil: new Date(until).toISOString(),
        };
      }
    }
    console.info(JSON.stringify({
      event: cached ? 'research_cache_hit' : 'research_cache_miss', runId, symbol: candidate.symbol,
      researchedAt: cached?.result.researchedAt, validUntil: cached?.validUntil,
    }));
    let result: ResearchResult;
    try {
      result = await researcher(candidate, cached);
      if (candidate.nse) applyNseFundamentals(result.assessment, result.reads, candidate.nse);
      validateAssessment(result.assessment, candidate, result.reads, now());
    } catch (error) {
      result = unsureResearch(candidate, error);
      if (candidate.nse) applyNseFundamentals(result.assessment, result.reads, candidate.nse);
    }
    result.cache = {
      hit: Boolean(cached), backgroundResearchedAt: cached?.result.researchedAt, validUntil: cached?.validUntil,
    };
    if (cached) {
      result.assessment.risks.push(`Background research from ${cached.result.researchedAt} is reused; later news, sector changes and corporate actions may not be reflected.`);
    }
    // A quote/outlook refresh must not extend the age of the background research.
    if (!cached && !result.failure && result.reads.length) {
      const record = cacheSchema.parse({
        version: 1, isin, symbol: candidate.symbol,
        baselineDate: candidate.baselineDate, asOfDate: candidate.asOfDate, result,
      });
      await atomicWrite(file, JSON.stringify(record));
    }
    return result;
  };
}
