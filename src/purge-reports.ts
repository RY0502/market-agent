import { loadReportConfig } from './config.js';
import { purgeReportStorage } from './report-storage.js';

const config = loadReportConfig();
console.log('Purging Cloudflare Workers KV and edge cache...');
try {
  const result = await purgeReportStorage(config);
  console.log(`Successfully purged ${result.purged} page(s) from Cloudflare Workers KV cache.`);
} catch (error) {
  console.error('Purge failed:', error);
  process.exit(1);
}
