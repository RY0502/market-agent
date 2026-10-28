import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

export function loadConfig() {
  const env = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().default('./data'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    NEON_DATABASE_URL: z.string().min(1),
  }).parse(process.env);
  return { ...env, DATA_DIR: path.resolve(env.DATA_DIR) };
}
