import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { z } from 'zod';
import type { RankedStock } from './research.js';
import { atomicWrite, readOptional } from './storage.js';

export function publicationRow(stock: RankedStock, updatedAt: string) {
  return {
    name: stock.candidate.name,
    price: stock.candidate.price,
    change: stock.candidate.change,
    change_percent: stock.candidate.changePercent,
    updated_at: updatedAt,
    profit_probability: stock.research.assessment.profitProbability,
  };
}

export type Publisher = (
  results: { gainers: RankedStock[]; losers: RankedStock[] }, runId: string,
) => Promise<void>;

export function publicationFile(root: string, runId: string): string {
  return path.join(root, 'runs', `${runId}.publication.json`);
}

export function createPublisher(url: string, key: string, root: string, request: typeof fetch = fetch): Publisher {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: request },
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
        top_losers: { phase: 'pending', rows: results.losers.map(stock => publicationRow(stock, now)) },
      },
    };
    const save = () => atomicWrite(file, JSON.stringify(progress, null, 2));
    await save();
    for (const table of ['top_gainers', 'top_losers'] as const) {
      const state = progress.tables[table];
      const { count, error: countError } = await client.from(table).select('id', { count: 'exact', head: true });
      if (countError || count === null) throw new Error(`Supabase count failed for ${table}: ${countError?.message ?? 'Missing row count'}`);
      if (count >= 100) {
        const { data, error } = await client.from(table).select('id')
          .order('updated_at', { ascending: true, nullsFirst: true }).order('id', { ascending: true }).limit(25);
        if (error) throw new Error(`Supabase oldest-row lookup failed for ${table}: ${error.message}`);
        const rows = z.array(z.object({ id: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]) })).length(25).parse(data);
        state.phase = 'cleanup_started';
        await save();
        const { error: deleteError } = await client.from(table).delete().in('id', rows.map(row => row.id));
        if (deleteError) throw new Error(`Supabase cleanup failed for ${table}; inspect disk progress before retrying: ${deleteError.message}`);
      }
      state.phase = 'cleanup_done';
      await save();
      if (state.rows.length) {
        state.phase = 'insert_started';
        await save();
        const { error } = await client.from(table).insert(state.rows);
        if (error) throw new Error(`Supabase insert failed or has an uncertain outcome for ${table}; inspect disk progress and database rows before retrying: ${error.message}`);
      }
      state.phase = 'inserted';
      await save();
    }
  };
}
