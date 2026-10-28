import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { z } from 'zod';

const rupees = z.coerce.number().finite().positive().refine(
  value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
  'Use amounts with at most two decimal places',
);
const envSchema = z.object({
  GAINERS_INCREASE_RS: rupees.default(100),
  LOSERS_DECREASE_RS: rupees.default(100),
  GAINERS_MIN_PRICE: rupees.default(200),
  GAINERS_MAX_PRICE: rupees.default(2000),
  LOSERS_MIN_PRICE: rupees.default(200),
  LOSERS_MAX_PRICE: rupees.default(1500),
}).superRefine((env, context) => {
  for (const group of ['GAINERS', 'LOSERS'] as const) {
    if (env[`${group}_MIN_PRICE`] > env[`${group}_MAX_PRICE`]) {
      context.addIssue({ code: 'custom', path: [`${group}_MAX_PRICE`], message: 'Maximum price must be at least minimum price' });
    }
  }
});

export interface ScreeningRule {
  threshold: number;
  minPrice: number;
  maxPrice: number;
}
export interface ScreeningConfig {
  gainers: ScreeningRule;
  losers: ScreeningRule;
}
export const SHORTLIST_SIZE = 25;

export function loadScreeningConfig(env?: Record<string, string | undefined>): ScreeningConfig {
  if (!env) {
    let file: Record<string, string> = {};
    try {
      file = parse(readFileSync('.env'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    // Only the six screening fields are consumed; reload .env for each new run.
    env = { ...process.env, ...file };
  }
  const parsed = envSchema.parse(env);
  return {
    gainers: { threshold: parsed.GAINERS_INCREASE_RS, minPrice: parsed.GAINERS_MIN_PRICE, maxPrice: parsed.GAINERS_MAX_PRICE },
    losers: { threshold: parsed.LOSERS_DECREASE_RS, minPrice: parsed.LOSERS_MIN_PRICE, maxPrice: parsed.LOSERS_MAX_PRICE },
  };
}

export function withinPrice(price: number, rule: ScreeningRule): boolean {
  return price >= rule.minPrice && price <= rule.maxPrice;
}
