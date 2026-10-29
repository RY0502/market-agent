import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const reportConfigSchema = z.object({
  CLOUDFLARE_REPORT_UPLOAD_TOKEN: z.string().min(32),
  CLOUDFLARE_REPORT_URL: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  }, 'Use the HTTPS Cloudflare Worker origin, without a path or credentials'),
});

export function loadReportConfig() {
  return reportConfigSchema.parse(process.env);
}

export function loadConfig() {
  const env = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().default('./data'),
    RESEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(5),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    NEON_DATABASE_URL: z.string().min(1),
  }).parse(process.env);
  return { ...env, ...loadReportConfig(), DATA_DIR: path.resolve(env.DATA_DIR) };
}
