import 'dotenv/config';
import { DatabaseClient, SCHEMA_SQL } from 'freetier-deepagent-framework';

if (!process.env.NEON_DATABASE_URL) throw new Error('NEON_DATABASE_URL is required');
const db = new DatabaseClient(process.env.NEON_DATABASE_URL);
await db.getSql()(SCHEMA_SQL);
console.log('Neon framework schema initialized. Apply supabase/migrations/001_profit_probability.sql separately in Supabase.');
