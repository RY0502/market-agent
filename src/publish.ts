import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { z } from 'zod';
import type { RankedStock } from './research.js';
import { atomicWrite, readOptional } from './storage.js';
import { ACTIVE_GROUPS } from './screening.js';

export function publicationRow(stock: RankedStock, updatedAt: string) {
  const report = z.object({ url: z.string().url(), expiresAt: z.string().datetime() }).parse(stock.report);
  if (new URL(report.url).protocol !== 'https:' || Date.parse(report.expiresAt) <= Date.parse(updatedAt)) {
    throw new Error('A valid, unexpired HTTPS stock report is required before publication');
  }
  return {
    name: stock.candidate.name,
    price: stock.candidate.price,
    change: stock.candidate.change,
    change_percent: stock.candidate.changePercent,
    updated_at: updatedAt,
    profit_probability: stock.research.assessment.profitProbability,
    report_url: report.url,
  };
}

export type Publisher = (
    results: { gainers: RankedStock[]; losers: RankedStock[] }, runId: string,
) => Promise<void>;

export function publicationFile(root: string, runId: string): string {
  return path.join(root, 'runs', `${runId}.publication.json`);
}

function failureDetails(response: {
  status: number; statusText: string;
  error: { message?: string; code?: string; details?: string; hint?: string } | null;
}, fallback = 'Empty error response'): string {
  const { status, statusText, error } = response;
  return [
    `HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    error?.message?.trim() || fallback,
    error?.code ? `code=${error.code}` : undefined,
    error?.details?.trim(), error?.hint?.trim(),
    status === 401 ? 'Check that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY match the same project and the key is valid.' : undefined,
  ].filter(Boolean).join('; ');
}

export function createPublisher(url: string, key: string, root: string, request: typeof fetch = fetch): Publisher {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: request },
    realtime: {
      transport: (typeof WebSocket !== 'undefined' ? WebSocket : class DummyWebSocket {}) as any,
    },
  });
  return async (results, runId) => {
    const file = publicationFile(root, runId);
    if (await readOptional(file)) {
      throw new Error('Publication progress already exists. Inspect it and reconcile Supabase manually before retrying; writes are not automatically replayed.');
    }
    const now = new Date().toISOString();
    const progress = {
      runId, updatedAt: now,
      tables: {
        top_gainers: { phase: 'pending', rows: results.gainers.map(stock => publicationRow(stock, now)) },
        top_losers: { phase: 'paused', rows: ACTIVE_GROUPS.includes('losers') ? results.losers.map(stock => publicationRow(stock, now)) : [] },
      },
    };
    const save = () => atomicWrite(file, JSON.stringify(progress, null, 2));
    await save();
    for (const table of ACTIVE_GROUPS.map(group => group === 'gainers' ? 'top_gainers' : 'top_losers')) {
      const state = progress.tables[table];
      const countResponse = await client.from(table).select('id', { count: 'exact' }).limit(1);
      const { count, error: countError } = countResponse;
      if (countError || count === null || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Supabase count failed for ${table}: ${failureDetails(
          countResponse, countError ? 'Empty error response' : 'Missing or invalid exact row count',
        )}`);
      }
      if (count >= 100) {
        const oldestResponse = await client.from(table).select('id')
            .order('updated_at', { ascending: true, nullsFirst: true }).order('id', { ascending: true }).limit(25);
        const { data, error } = oldestResponse;
        if (error) throw new Error(`Supabase oldest-row lookup failed for ${table}: ${failureDetails(oldestResponse)}`);
        const rows = z.array(z.object({ id: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]) })).length(25).parse(data);
        state.phase = 'cleanup_started';
        await save();
        const deleteResponse = await client.from(table).delete().in('id', rows.map(row => row.id));
        if (deleteResponse.error) throw new Error(`Supabase cleanup failed for ${table}; inspect disk progress before retrying: ${failureDetails(deleteResponse)}`);
      }
      state.phase = 'cleanup_done';
      await save();
      if (state.rows.length) {
        state.phase = 'insert_started';
        await save();
        const insertResponse = await client.from(table).insert(state.rows);
        if (insertResponse.error) throw new Error(`Supabase insert failed or has an uncertain outcome for ${table}; inspect disk progress and database rows before retrying: ${failureDetails(insertResponse)}`);
      }
      state.phase = 'inserted';
      await save();
    }
  };
}