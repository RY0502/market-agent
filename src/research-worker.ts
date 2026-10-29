import { CONFIG, DatabaseClient } from 'freetier-deepagent-framework';
import { z } from 'zod';
import type { Candidate } from './bhav.js';
import { createInProcessResearcher, type CachedResearchContext } from './research.js';
import { researchLimitsSchema } from './research-control.js';

process.once('disconnect', () => process.exit(1));

process.once('message', async (input: { root: string; runId: string; candidate: Candidate; limits: unknown; cached?: CachedResearchContext }) => {
  const fail = (error: unknown): void => {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  };
  try {
    const limits = researchLimitsSchema.parse(input.limits);
    const db = new DatabaseClient(z.string().min(1).parse(CONFIG.NEON_DATABASE_URL));
    const result = await createInProcessResearcher(db, input.root, input.runId, limits, fail)(input.candidate, input.cached);
    process.send?.({ type: 'result', result });
  } catch (error) {
    fail(error);
  }
});
