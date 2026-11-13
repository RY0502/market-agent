import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { callTextLlm, FreeTierEmbeddings } from 'freetier-deepagent-framework';
import { addDays } from './dates.js';
import { BhavStore, MissingBhavcopy, type Equity } from './bhav.js';
import { MilvusService, type MarketInsight } from './milvus.js';
import { queryExaNews } from './exa.js';

export function loadEvaluationRegistry(dataDir?: string): Record<string, string> {
  if (!dataDir) return {};
  try {
    const file = path.join(dataDir, 'milvus-evaluations.json');
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch {
    // Ignore and return empty
  }
  return {};
}

export function saveEvaluationRegistry(registry: Record<string, string>, dataDir?: string): void {
  if (!dataDir) return;
  try {
    const file = path.join(dataDir, 'milvus-evaluations.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(registry, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Prediction Accuracy] Failed to save milvus evaluation registry:', err);
  }
}

export function extractSymbolFromReportUrl(reportUrl?: string | null): string | null {
  if (!reportUrl) return null;
  try {
    const url = new URL(reportUrl);
    const filename = url.pathname.split('/').filter(Boolean).pop();
    if (!filename) return null;
    const nameWithoutExt = filename.replace(/\.html$/i, '');
    const decoded = decodeURIComponent(nameWithoutExt).trim().toUpperCase();
    return decoded || null;
  } catch {
    const match = reportUrl.match(/\/([^\/?#]+)\.html(?:[?#]|$)/i);
    if (!match || !match[1]) return null;
    return decodeURIComponent(match[1]).trim().toUpperCase() || null;
  }
}

export async function getLatestTradingBhav(
  bhavStore: BhavStore,
  targetDate: string,
  maxLookback = 5,
): Promise<{ date: string; equities: Equity[] }> {
  let date = targetDate;
  for (let i = 0; i < maxLookback; i++) {
    try {
      const equities = await bhavStore.load(date);
      if (equities && equities.length > 0) {
        return { date, equities };
      }
    } catch (err) {
      if (err instanceof MissingBhavcopy) {
        date = addDays(date, -1);
        continue;
      }
      throw err;
    }
    date = addDays(date, -1);
  }
  throw new Error(`Unable to load trading bhavcopy within ${maxLookback} days of ${targetDate}`);
}

export interface PastPredictionRow {
  name: string;
  price: number;
  change?: number;
  change_percent?: number;
  profit_probability: string | null;
  report_url: string | null;
  updated_at: string;
}

export interface PredictionEvaluationResult {
  symbol: string;
  name: string;
  predictedProbability: string;
  prevClose: number;
  currentHigh: number;
  gainPct: number;
  isCorrect: boolean;
  horizon?: 'short_term' | 'positional_30d';
  absoluteGain?: number;
  observation?: string;
  category?: string;
  fortified?: boolean;
  inserted?: boolean;
}

export interface EvaluationSummary {
  evaluatedCount: number;
  correctCount: number;
  fortifiedCount: number;
  insertedCount: number;
  results: PredictionEvaluationResult[];
  positionalSummary?: {
    evaluatedCount: number;
    correctCount: number;
    fortifiedCount: number;
    insertedCount: number;
    results: PredictionEvaluationResult[];
  };
}

export interface EvaluatePreviousRunOptions {
  supabaseUrl: string;
  supabaseKey: string;
  bhavStore: BhavStore;
  currentDate: string;
  currentEquities?: Equity[];
  currentRunStartedAt?: string;
  thresholdPct?: number; // default 2.0%
  similarityThreshold?: number; // default 0.82
  milvusService?: MilvusService | null;
  embeddings?: { embedQuery(text: string): Promise<number[]> };
  exaSearch?: (query: string) => Promise<{ title?: string; url: string; text: string }[]>;
  textLlm?: (input: { prompt: string; system?: string }) => Promise<{ text?: string } | string>;
  request?: typeof fetch;
  positionalLookbackDays?: number; // default 30 days
  positionalThresholdPct?: number; // default 5.0%
  positionalMinRupeesGain?: number; // default 100 (e.g. +Rs 100 move)
  enablePositionalEvaluation?: boolean; // default true
  dataDir?: string;
}

interface CandidateToProcess {
  row: PastPredictionRow;
  symbol: string;
  equity: Equity;
  gainPct: number;
  isCorrect: boolean;
  horizon: 'short_term' | 'positional_30d';
  daysElapsed?: number;
}

async function processEvaluationCandidates(
  candidates: CandidateToProcess[],
  options: {
    embeddings: { embedQuery(text: string): Promise<number[]> };
    searchExa: (query: string) => Promise<{ title?: string; url: string; text: string }[]>;
    runLlm: (input: { prompt: string; system?: string }) => Promise<{ text?: string } | string>;
    milvusService?: MilvusService | null;
    currentDate: string;
    similarityThreshold: number;
    evaluationRegistry: Record<string, string>;
  },
): Promise<{
  correctCount: number;
  fortifiedCount: number;
  insertedCount: number;
  results: PredictionEvaluationResult[];
}> {
  const results: PredictionEvaluationResult[] = [];
  let correctCount = 0;
  let fortifiedCount = 0;
  let insertedCount = 0;

  const batchSize = 3;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    await Promise.all(batch.map(async ({ row, symbol, equity: eq, gainPct, isCorrect, horizon, daysElapsed }) => {
      try {
        if (isCorrect) correctCount++;

        const itemResult: PredictionEvaluationResult = {
          symbol,
          name: row.name,
          predictedProbability: row.profit_probability!,
          prevClose: row.price,
          currentHigh: eq.high,
          gainPct: Math.round(gainPct * 100) / 100,
          isCorrect,
          horizon,
          absoluteGain: Math.round((eq.high - row.price) * 100) / 100,
        };

        // Exa analysis & Milvus learning only for stocks predicted >= 1 month earlier (>= 28 days)
        const isEligibleForExa = (daysElapsed ?? 0) >= 28 || horizon === 'positional_30d';

        if (isEligibleForExa) {
          const symKey = symbol.toUpperCase();
          const lastEvalDate = options.evaluationRegistry[symKey];
          let recentlyEvaluated = false;
          let daysSince: number | undefined;

          if (lastEvalDate) {
            const diffMs = new Date(options.currentDate).getTime() - new Date(lastEvalDate).getTime();
            daysSince = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            if (daysSince < 30) {
              recentlyEvaluated = true;
            }
          }

          if (recentlyEvaluated) {
            console.log(`[Prediction Accuracy] Skipping Exa & Milvus re-evaluation for ${symbol}; evaluated ${daysSince} days ago (< 30 days).`);
          } else {
            try {
              const exaQuery = horizon === 'positional_30d'
                ? `"${row.name}" (${symbol}) NSE India performance contract earnings brand news`
                : `"${row.name}" (${symbol}) NSE India business news contract acquisition earnings results`;
              const news = await options.searchExa(exaQuery).catch(() => []);
              const newsSnippets = news
                .map(n => n.title ? `${n.title}: ${n.text}` : n.text)
                .join('\n---\n')
                .slice(0, 3000);

              const prompt = horizon === 'positional_30d'
                ? `You are a financial market analyst evaluating 30-day positional momentum performance.
Stock: ${row.name} (${symbol})
Initial Recommendation Price: INR ${row.price}
Current High/Price after ~${daysElapsed ?? 30} days: INR ${eq.high} (30-day move: ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%, Absolute Delta: INR ${Math.round(eq.high - row.price)})
Predicted Outlook was: ${row.profit_probability} (30-day Outcome: ${isCorrect ? 'Profitable / Correct' : 'Unprofitable / Incorrect'})

Recent news / context:
${newsSnippets || 'No direct headline news detected. Technical / volume / institutional movement.'}

Task:
Extract a generic, reusable observation on why this type of stock ${isCorrect ? 'sustained a 30-day multi-week uptrend (e.g. brand equity, institutional sponsorship, structural secular tailwinds, IP moats, high traded liquidity)' : 'reversed or decayed over 30 days (e.g. low liquidity, lack of institutional ownership, operator distribution, cyclical/commodity headwinds)'}.
Do NOT mention the specific stock symbol or current date in the generic observation text.

Return ONLY a JSON object:
{
  "observation": "Clear, concise generic rule of thumb on 30-day positional momentum or risk (1-2 sentences)",
  "category": "Brand & Institutional Liquidity | Sector Thematic Supercycle | Moat & Quality Compounder | Operator Distribution | Earnings Surprise | Technical Momentum"
}`
                : `You are a financial market analyst extracting generalizable trading patterns.
Stock: ${row.name} (${symbol})
Previous Close: INR ${row.price}
Current High: INR ${eq.high} (Intraday move: ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%)
Prediction was: ${row.profit_probability} (Outcome: ${isCorrect ? 'Correct' : 'Incorrect'})

Recent news / context:
${newsSnippets || 'No direct headline news detected. Technical / volume surge.'}

Task:
Extract a generic, reusable, sector- or market-level observation, catalyst or rule of thumb that explains or correlates with this price movement (e.g. "Winning large defense or engineering contracts creates sustained positive momentum in capital goods stocks", "Acquisition of a smaller competitor in the IT services sector provides short-term positive price momentum", "Weak volume growth leads to persistent selling pressure in consumer staples").
Do NOT mention the specific stock symbol or current date in the generic observation text.

Return ONLY a JSON object:
{
  "observation": "Clear, concise generic market rule or catalyst observation (1-2 sentences)",
  "category": "M&A | Order Win | Earnings Surprise | Geopolitical | Regulatory | Macroeconomic | Technical Momentum"
}`;

              const llmResponse = await options.runLlm({ prompt });
              const textOutput = typeof llmResponse === 'string' ? llmResponse : llmResponse.text ?? '';
              const cleaned = textOutput.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
              const parsed = JSON.parse(cleaned);

              if (parsed.observation && typeof parsed.observation === 'string' && parsed.observation.length >= 20) {
                const observation = parsed.observation.trim();
                const category = String(parsed.category || (horizon === 'positional_30d' ? 'Brand & Institutional Liquidity' : 'General')).trim();
                itemResult.observation = observation;
                itemResult.category = category;

                if (options.milvusService) {
                  const vector = await options.embeddings.embedQuery(observation);
                  const matchedInsight = await options.milvusService.searchInsight(vector, 1, options.similarityThreshold, 'monthly');

                  if (matchedInsight) {
                    await options.milvusService.fortifyInsight(matchedInsight, symbol, options.currentDate, observation, vector, 'monthly');
                    itemResult.fortified = true;
                    fortifiedCount++;
                  } else {
                    await options.milvusService.insertInsight(vector, observation, category, options.currentDate, symbol, 'monthly');
                    itemResult.inserted = true;
                    insertedCount++;
                  }
                  options.evaluationRegistry[symKey] = options.currentDate;
                }
              }
            } catch (err) {
              console.warn(`[Prediction Accuracy] Failed to extract/vectorize insight for ${symbol}, skipping stock:`, err);
            }
          }
        } else {
          // SHORT-TERM FACT GUIDANCE:
          // Based mainly on price movements seen from our data files rather than any research.
          // The profit accuracy threshold serves as the empirical ground truth.
          const symKey = symbol.toUpperCase();
          const lastEvalDate = options.evaluationRegistry[symKey];
          let recentlyEvaluated = false;
          let daysSince: number | undefined;

          if (lastEvalDate) {
            const diffMs = new Date(options.currentDate).getTime() - new Date(lastEvalDate).getTime();
            daysSince = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            if (daysSince < 7) {
              recentlyEvaluated = true;
            }
          }

          if (recentlyEvaluated) {
            console.log(`[Prediction Accuracy] Skipping short-term fact re-evaluation for ${symbol}; evaluated ${daysSince} days ago (< 7 days).`);
          } else {
            try {
              const outcomeDesc = isCorrect
                ? `Achieved short-term profit accuracy (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}% rise from base INR ${row.price} to high INR ${eq.high}, close INR ${eq.close}), satisfying the profit threshold.`
                : `Missed short-term profit target (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}% move from base INR ${row.price} to high INR ${eq.high}, close INR ${eq.close}), failing the profit threshold.`;

              const shortTermFact = `${row.name} (${symbol}): Short-term price movement from bhavcopy data showed ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}% return (${outcomeDesc}) following previous ${row.profit_probability} outlook. Traded turnover: INR ${(eq.turnover / 10_000_000).toFixed(2)} Cr.`;
              const category = 'Short-Term Price Movement Fact';
              itemResult.observation = shortTermFact;
              itemResult.category = category;

              if (options.milvusService) {
                const vector = await options.embeddings.embedQuery(shortTermFact);
                const matchedInsight = await options.milvusService.searchInsight(vector, 1, options.similarityThreshold, 'short_term');

                if (matchedInsight) {
                  await options.milvusService.fortifyInsight(matchedInsight, symbol, options.currentDate, shortTermFact, vector, 'short_term');
                  itemResult.fortified = true;
                  fortifiedCount++;
                } else {
                  await options.milvusService.insertInsight(vector, shortTermFact, category, options.currentDate, symbol, 'short_term');
                  itemResult.inserted = true;
                  insertedCount++;
                }
                options.evaluationRegistry[symKey] = options.currentDate;
              }
            } catch (err) {
              console.warn(`[Prediction Accuracy] Failed to record short-term price movement fact for ${symbol}:`, err);
            }
          }
        }

        results.push(itemResult);
      } catch (stockErr) {
        console.warn(`[Prediction Accuracy] Error evaluating stock ${symbol}, skipping:`, stockErr);
      }
    }));
  }

  return { correctCount, fortifiedCount, insertedCount, results };
}

export async function evaluatePreviousRun(
  options: EvaluatePreviousRunOptions,
): Promise<EvaluationSummary> {
  const thresholdPct = options.thresholdPct ?? 2.0;
  const similarityThreshold = options.similarityThreshold ?? 0.82;
  const request = options.request ?? fetch;

  const supabase = createClient(options.supabaseUrl, options.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: request },
  });

  // Find the latest updated_at from the previous run
  let query = supabase.from('top_gainers').select('updated_at').order('updated_at', { ascending: false });
  if (options.currentRunStartedAt) {
    query = query.lt('updated_at', options.currentRunStartedAt);
  }
  const { data: latestDateRows, error: dateError } = await query.limit(1);

  if (dateError) {
    console.warn('[Prediction Accuracy] Failed to query previous runs from Supabase:', dateError.message);
    return { evaluatedCount: 0, correctCount: 0, fortifiedCount: 0, insertedCount: 0, results: [] };
  }

  if (!latestDateRows || latestDateRows.length === 0) {
    console.log('[Prediction Accuracy] No previous run found in Supabase to evaluate.');
    return { evaluatedCount: 0, correctCount: 0, fortifiedCount: 0, insertedCount: 0, results: [] };
  }

  const previousRunUpdatedAt = latestDateRows[0]!.updated_at;
  const previousRunDaysElapsed = Math.max(0, Math.round((new Date(options.currentDate).getTime() - new Date(previousRunUpdatedAt).getTime()) / (1000 * 60 * 60 * 24)));

  // Fetch all rows for the previous run from top_gainers (and top_losers)
  const [gainersRes, losersRes] = await Promise.all([
    supabase.from('top_gainers').select('*').eq('updated_at', previousRunUpdatedAt),
    supabase.from('top_losers').select('*').eq('updated_at', previousRunUpdatedAt),
  ]);

  const pastRows: PastPredictionRow[] = [
    ...(gainersRes.data || []),
    ...(losersRes.data || []),
  ];

  if (pastRows.length === 0) {
    console.log('[Prediction Accuracy] No stocks found for previous run timestamp:', previousRunUpdatedAt);
    return { evaluatedCount: 0, correctCount: 0, fortifiedCount: 0, insertedCount: 0, results: [] };
  }

  // Load current trading day bhavcopy (with holiday lookback if needed)
  let equities = options.currentEquities;
  if (!equities || equities.length === 0) {
    const loaded = await getLatestTradingBhav(options.bhavStore, options.currentDate);
    equities = loaded.equities;
  }

  const equityMap = new Map<string, Equity>(
    equities.map(e => [e.symbol.trim().toUpperCase(), e]),
  );

  const candidatesToEvaluate: CandidateToProcess[] = [];

  for (const row of pastRows) {
    const symbol = extractSymbolFromReportUrl(row.report_url);
    if (!symbol) continue;

    const prob = row.profit_probability?.toLowerCase();
    if (!prob || prob === 'unsure') {
      continue; // Skip null / unsure predictions
    }

    const eq = equityMap.get(symbol);
    if (!eq) continue;

    const prevClose = row.price;
    if (!prevClose || prevClose <= 0) continue;

    const currentHigh = eq.high;
    const gainPct = ((currentHigh - prevClose) / prevClose) * 100;

    let isCorrect = false;
    if (prob === 'high' || prob === 'medium') {
      isCorrect = gainPct >= thresholdPct;
    } else if (prob === 'low') {
      isCorrect = currentHigh <= prevClose;
    }

    candidatesToEvaluate.push({
      row,
      symbol,
      equity: eq,
      gainPct,
      isCorrect,
      horizon: 'short_term',
      daysElapsed: previousRunDaysElapsed,
    });
  }

  console.log(`[Prediction Accuracy] Evaluating ${candidatesToEvaluate.length} past predicted stocks (short-term)...`);

  const embeddings = options.embeddings ?? new FreeTierEmbeddings();
  const searchExa = options.exaSearch ?? (q => queryExaNews(q, undefined, request));
  const runLlm = options.textLlm ?? (input => callTextLlm(input));

  const dataDir = options.dataDir ?? options.bhavStore?.root;
  const evaluationRegistry = loadEvaluationRegistry(dataDir);

  const evaluationContext = {
    embeddings,
    searchExa,
    runLlm,
    milvusService: options.milvusService,
    currentDate: options.currentDate,
    similarityThreshold,
    evaluationRegistry,
  };

  const shortTermOutcome = await processEvaluationCandidates(candidatesToEvaluate, evaluationContext);

  console.log(
    `[Prediction Accuracy] Short-term Summary: ${candidatesToEvaluate.length} evaluated, ${shortTermOutcome.correctCount} correct (${candidatesToEvaluate.length ? Math.round((shortTermOutcome.correctCount / candidatesToEvaluate.length) * 100) : 0}%), ${shortTermOutcome.fortifiedCount} fortified, ${shortTermOutcome.insertedCount} inserted.`,
  );

  // Check for a historical run ~20-40 days ago to evaluate 30-day positional accuracy
  const enablePositional = options.enablePositionalEvaluation ?? true;
  let positionalSummary: EvaluationSummary['positionalSummary'];

  if (enablePositional) {
    try {
      const positionalDays = options.positionalLookbackDays ?? 30;
      const minDate = addDays(options.currentDate, -(positionalDays + 10));
      const maxDate = addDays(options.currentDate, -(positionalDays - 10));

      const { data: posDateRows } = await supabase
        .from('top_gainers')
        .select('updated_at')
        .gte('updated_at', `${minDate}T00:00:00.000Z`)
        .lte('updated_at', `${maxDate}T23:59:59.999Z`)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (posDateRows && posDateRows.length > 0) {
        const posUpdatedAt = posDateRows[0]!.updated_at;
        const daysElapsed = Math.round((new Date(options.currentDate).getTime() - new Date(posUpdatedAt).getTime()) / (1000 * 60 * 60 * 24));

        if (daysElapsed >= 15 && posUpdatedAt !== previousRunUpdatedAt) {
          const [posGainersRes, posLosersRes] = await Promise.all([
            supabase.from('top_gainers').select('*').eq('updated_at', posUpdatedAt),
            supabase.from('top_losers').select('*').eq('updated_at', posUpdatedAt),
          ]);
          const posPastRows: PastPredictionRow[] = [
            ...(posGainersRes.data || []),
            ...(posLosersRes.data || []),
          ];

          const posCandidatesToEvaluate: CandidateToProcess[] = [];
          const posThresholdPct = options.positionalThresholdPct ?? 5.0;
          const posMinRupeesGain = options.positionalMinRupeesGain ?? 100;

          for (const row of posPastRows) {
            const symbol = extractSymbolFromReportUrl(row.report_url);
            if (!symbol) continue;

            const prob = row.profit_probability?.toLowerCase();
            if (!prob || prob === 'unsure') continue;

            const eq = equityMap.get(symbol);
            if (!eq) continue;

            const prevClose = row.price;
            if (!prevClose || prevClose <= 0) continue;

            const currentHigh = eq.high;
            const gainPct = ((currentHigh - prevClose) / prevClose) * 100;
            const rsGain = currentHigh - prevClose;

            let isCorrect = false;
            if (prob === 'high' || prob === 'medium') {
              isCorrect = gainPct >= posThresholdPct || rsGain >= posMinRupeesGain;
            } else if (prob === 'low') {
              isCorrect = currentHigh <= prevClose;
            }

            posCandidatesToEvaluate.push({
              row,
              symbol,
              equity: eq,
              gainPct,
              isCorrect,
              horizon: 'positional_30d',
              daysElapsed,
            });
          }

          if (posCandidatesToEvaluate.length > 0) {
            console.log(`[Prediction Accuracy] Evaluating ${posCandidatesToEvaluate.length} stocks for ~${daysElapsed}-day positional trend...`);
            const posOutcome = await processEvaluationCandidates(posCandidatesToEvaluate, evaluationContext);
            positionalSummary = {
              evaluatedCount: posCandidatesToEvaluate.length,
              correctCount: posOutcome.correctCount,
              fortifiedCount: posOutcome.fortifiedCount,
              insertedCount: posOutcome.insertedCount,
              results: posOutcome.results,
            };
            console.log(
              `[Prediction Accuracy] Positional (~30d) Summary: ${posCandidatesToEvaluate.length} evaluated, ${posOutcome.correctCount} correct (${posCandidatesToEvaluate.length ? Math.round((posOutcome.correctCount / posCandidatesToEvaluate.length) * 100) : 0}%), ${posOutcome.fortifiedCount} fortified, ${posOutcome.insertedCount} inserted.`,
            );
          }
        }
      }
    } catch (posErr) {
      console.warn('[Prediction Accuracy] Failed to evaluate 30-day positional accuracy, continuing:', posErr);
    }
  }

  saveEvaluationRegistry(evaluationRegistry, dataDir);

  return {
    evaluatedCount: candidatesToEvaluate.length,
    correctCount: shortTermOutcome.correctCount,
    fortifiedCount: shortTermOutcome.fortifiedCount,
    insertedCount: shortTermOutcome.insertedCount,
    results: shortTermOutcome.results,
    ...(positionalSummary ? { positionalSummary } : {}),
  };
}
