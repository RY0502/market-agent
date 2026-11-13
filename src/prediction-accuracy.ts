import { createClient } from '@supabase/supabase-js';
import { callTextLlm, FreeTierEmbeddings } from 'freetier-deepagent-framework';
import { addDays } from './dates.js';
import { BhavStore, MissingBhavcopy, type Equity } from './bhav.js';
import { MilvusService, type MarketInsight } from './milvus.js';
import { queryExaNews } from './exa.js';

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

  const candidatesToEvaluate: {
    row: PastPredictionRow;
    symbol: string;
    equity: Equity;
    gainPct: number;
    isCorrect: boolean;
  }[] = [];

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
    });
  }

  console.log(`[Prediction Accuracy] Evaluating ${candidatesToEvaluate.length} past predicted stocks...`);

  const results: PredictionEvaluationResult[] = [];
  let correctCount = 0;
  let fortifiedCount = 0;
  let insertedCount = 0;

  const embeddings = options.embeddings ?? new FreeTierEmbeddings();
  const searchExa = options.exaSearch ?? (q => queryExaNews(q, undefined, request));
  const runLlm = options.textLlm ?? (input => callTextLlm(input));

  // Process in parallel batches of 3
  const batchSize = 3;
  for (let i = 0; i < candidatesToEvaluate.length; i += batchSize) {
    const batch = candidatesToEvaluate.slice(i, i + batchSize);
    await Promise.all(batch.map(async ({ row, symbol, equity: eq, gainPct, isCorrect }) => {
      if (isCorrect) correctCount++;

      const itemResult: PredictionEvaluationResult = {
        symbol,
        name: row.name,
        predictedProbability: row.profit_probability!,
        prevClose: row.price,
        currentHigh: eq.high,
        gainPct: Math.round(gainPct * 100) / 100,
        isCorrect,
      };

      try {
        // Search Exa for news/events explaining why the stock moved
        const exaQuery = `"${row.name}" (${symbol}) NSE India business news contract acquisition earnings results`;
        const news = await searchExa(exaQuery).catch(() => []);
        const newsSnippets = news
          .map(n => n.title ? `${n.title}: ${n.text}` : n.text)
          .join('\n---\n')
          .slice(0, 3000);

        const prompt = `You are a financial market analyst extracting generalizable trading patterns.
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

        const llmResponse = await runLlm({ prompt });
        const textOutput = typeof llmResponse === 'string' ? llmResponse : llmResponse.text ?? '';
        const cleaned = textOutput.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
        const parsed = JSON.parse(cleaned);

        if (parsed.observation && typeof parsed.observation === 'string' && parsed.observation.length >= 20) {
          const observation = parsed.observation.trim();
          const category = String(parsed.category || 'General').trim();
          itemResult.observation = observation;
          itemResult.category = category;

          if (options.milvusService) {
            const vector = await embeddings.embedQuery(observation);
            const matchedInsight = await options.milvusService.searchInsight(vector, 1, similarityThreshold);

            if (matchedInsight) {
              await options.milvusService.fortifyInsight(matchedInsight, symbol, options.currentDate, observation, vector);
              itemResult.fortified = true;
              fortifiedCount++;
            } else {
              await options.milvusService.insertInsight(vector, observation, category, options.currentDate, symbol);
              itemResult.inserted = true;
              insertedCount++;
            }
          }
        }
      } catch (err) {
        console.warn(`[Prediction Accuracy] Failed to extract/vectorize insight for ${symbol}:`, err);
      }

      results.push(itemResult);
    }));
  }

  console.log(
    `[Prediction Accuracy] Summary: ${candidatesToEvaluate.length} evaluated, ${correctCount} correct (${candidatesToEvaluate.length ? Math.round((correctCount / candidatesToEvaluate.length) * 100) : 0}%), ${fortifiedCount} fortified, ${insertedCount} inserted.`,
  );

  return {
    evaluatedCount: candidatesToEvaluate.length,
    correctCount,
    fortifiedCount,
    insertedCount,
    results,
  };
}
