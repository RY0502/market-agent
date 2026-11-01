import { loadReportConfig } from './config.js';
import { purgeReportStorage } from './report-storage.js';

const config = loadReportConfig();
console.log('Purging Cloudflare Workers KV and edge cache...');
try {
  const result = await purgeReportStorage(config);
  console.log(`Successfully purged ${result.purged} page(s) from Cloudflare Workers KV cache.`);
} catch (error: any) {
  if (error?.message?.includes('HTTP 405')) {
    console.error('Purge failed (HTTP 405): The deployed Cloudflare Worker does not have the /stock-report-purge endpoint yet.');
    console.error('Please deploy the updated worker from the cloudflare directory:');
    console.error('  cd cloudflare');
    console.error('  npx wrangler deploy');
  } else {
    console.error('Purge failed:', error);
  }
  process.exit(1);
}
