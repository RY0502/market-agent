import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichStocks, attachTradingView } from '../src/tradingview.js';
import type { RankedStock } from '../src/research.js';
import { candidate, research } from './helpers.js';

function stock(symbol = 'EXAMPLE'): RankedStock {
  return {
    candidate: candidate({ symbol, nse: {
      asOf: '2026-10-26', pe: null, adjustedPe: null, marketCapCrore: null,
      historical: { pe: null, adjustedPe: null, marketCapCrore: null }, corporateActions: [], history: [], missingFiles: [],
    } }),
    research: research(symbol, { pe: null, marketCapCrore: null }),
    rank: 1, riskScore: 20, recoveryScore: 80,
  };
}
const page = (symbol: string) => ({
  url: `https://in.tradingview.com/symbols/NSE-${symbol}/`,
  output: JSON.stringify({ symbol, pe: '25', marketCap: 'INR 1000 Cr' }), observedAt: new Date().toISOString(),
});
const delay = () => new Promise(resolve => setTimeout(resolve, 3));

for (const concurrency of [1, 5]) {
  test(`Exa, scraping and final reassessment preserve concurrency ${concurrency}, rank and isolated failures`, async () => {
    const stocks = Array.from({ length: 9 }, (_, i) => ({ ...stock(`STOCK${i}`), rank: i + 1 }));
    let active = 0;
    let peak = 0;
    let searches = 0;
    let assessments = 0;
    await enrichStocks(stocks, '/unused', 'test', async symbol => {
      if (symbol === 'STOCK2') throw new Error('Scrape unavailable');
      return page(symbol);
    }, async (item, prior) => {
      assessments++;
      assert.ok(prior.reads.some(read => read.kind === 'exa'));
      await delay();
      active--;
      if (item.candidate.symbol === 'STOCK3') throw new Error('Reassessment unavailable');
      prior.assessment.profitProbability = 'medium';
      return prior;
    }, {
      concurrency,
      exaSearch: async (candidate, existing) => {
        searches++;
        peak = Math.max(peak, ++active);
        assert.ok(existing.length);
        await delay();
        return [{
          evidenceId: `exa_${candidate.symbol}`, url: `https://news.example/${candidate.symbol}`, kind: 'exa',
          observedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), newsDays: 7,
          output: `${candidate.symbol} company disclosure describes the expansion project and the execution risks.`,
        }];
      },
    });
    assert.equal(peak, concurrency);
    assert.equal(active, 0);
    assert.equal(searches, 9);
    assert.equal(assessments, 9, 'At most one reassessment per stock after combined enrichment');
    assert.deepEqual(stocks.map(item => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(stocks[3]!.research.assessment.profitProbability, 'high', 'Failed reassessment retains the original decision');
    assert.ok(stocks[3]!.research.reads.some(read => read.kind === 'exa'), 'Supplemental evidence survives for audit');
    assert.ok(stocks[3]!.research.assessment.warnings?.some(warning => warning.code === 'enrichment_reassessment_failed'));
    assert.equal(stocks[2]!.research.assessment.profitProbability, 'medium', 'A failed scrape does not discard Exa evidence');
    assert.ok(stocks[2]!.research.assessment.warnings?.some(warning => warning.code === 'tradingview_enrichment_failed'));
  });
}

test('execution failures skip enrichment and Exa failures do not prevent an independent financial-data fallback', async () => {
  const failed = stock();
  failed.research.failure = { name: 'Error', message: 'Provider failure' };
  const missing = stock('MISSING');
  let queries = 0;
  let scrapes = 0;
  await enrichStocks([failed, missing], '/unused', 'test', async symbol => {
    scrapes++;
    return page(symbol);
  }, async (_stock, prior) => prior, {
    concurrency: 5,
    exaSearch: async () => { queries++; throw new Error('Search quota unavailable'); },
  });
  assert.equal(queries, 1);
  assert.equal(scrapes, 1);
  assert.equal(failed.research.failure?.message, 'Provider failure');
  assert.equal(missing.research.assessment.pe?.value, 25);
  assert.ok(missing.research.assessment.warnings?.some(warning => warning.code === 'exa_fallback_failed'));
});

test('sufficient fresh coverage avoids Exa, missing fundamentals use TradingView, unsure alone triggers neither', async () => {
  const complete = stock();
  complete.candidate.nse!.pe = { value: 20, source: { url: 'https://nse.example/pe', excerpt: 'P/E 20' } };
  complete.candidate.nse!.marketCapCrore = { value: 1000, source: { url: 'https://nse.example/cap', excerpt: '1000 Cr' } };
  complete.research.assessment.profitProbability = null;
  complete.research.reads = [
    { url: 'https://news.example/article', output: 'The company announced a project and outlined the execution risks in a dated press release.' },
    { url: 'https://filings.example/article', output: 'A separate disclosure establishes project funding and identifies outstanding regulatory approvals.' },
  ].map(item => ({ ...item, kind: 'tavily' as const, observedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), newsDays: 7 }));
  await enrichStocks([complete], '/unused', 'test', async () => {
    assert.fail('Unsure alone must not trigger scraping');
  }, async () => { assert.fail('No new evidence requires no reassessment'); }, {
    exaSearch: async () => { assert.fail('Sufficient coverage must not trigger Exa'); },
  });
});

test('confirmed negative displayed TTM EPS is distinguished from absent P/E without assuming other periods', () => {
  const item = stock();
  const negative = attachTradingView(item, {
    ...page('EXAMPLE'), output: JSON.stringify({ symbol: 'EXAMPLE', pe: null, basicEpsTtm: '-2.50 INR' }),
  });
  assert.equal(negative.assessment.pe, null);
  assert.ok(negative.assessment.warnings?.some(warning => warning.code === 'pe_not_meaningful'));
  const unknown = attachTradingView(item, {
    ...page('EXAMPLE'), output: JSON.stringify({ symbol: 'EXAMPLE', pe: null, companyDescription: 'A manufacturing company.' }),
  });
  assert.ok(!unknown.assessment.warnings?.some(warning => warning.code === 'pe_not_meaningful'));
});

test('enrichment defaults to five and honors sequential environment configuration without launching work for invalid limits', async () => {
  const previous = process.env.RESEARCH_CONCURRENCY;
  try {
    for (const configured of [undefined, '1']) {
      if (configured === undefined) delete process.env.RESEARCH_CONCURRENCY;
      else process.env.RESEARCH_CONCURRENCY = configured;
      let active = 0;
      let peak = 0;
      await enrichStocks(Array.from({ length: 6 }, (_, index) => stock(`STOCK${index}`)), '/unused', 'test',
        async symbol => page(symbol), async (_stock, prior) => prior, {
          exaSearch: async () => {
            peak = Math.max(peak, ++active);
            await delay();
            active--;
            return [];
          },
        });
      assert.equal(peak, configured === '1' ? 1 : 5);
    }
    process.env.RESEARCH_CONCURRENCY = '0';
    await assert.rejects(enrichStocks([stock()], '/unused', 'test', async () => {
      assert.fail('Invalid concurrency must not launch scraping');
    }, async () => { assert.fail('Invalid concurrency must not launch reassessment'); }, {
      exaSearch: async () => { assert.fail('Invalid concurrency must not launch Exa'); },
    }));
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_CONCURRENCY;
    else process.env.RESEARCH_CONCURRENCY = previous;
  }
});
