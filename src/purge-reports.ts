import { loadConfig, loadReportConfig } from './config.js';
import { purgeReportStorage } from './report-storage.js';
import { createClient } from '@supabase/supabase-js';

const config = loadReportConfig();
console.log('Purging Cloudflare Workers KV and edge cache...');
try {
  const result = await purgeReportStorage(config);
  console.log(`Successfully purged ${result.purged} page(s) from Cloudflare Workers KV cache.`);
} catch (error: any) {
  if (error?.message?.includes('HTTP 405')) {
    console.log('Worker /stock-report-purge endpoint not yet active on live worker.');
    console.log('Collecting known report paths from Supabase to purge existing pages...');
    try {
      const fullConfig = loadConfig();
      const supabase = createClient(fullConfig.SUPABASE_URL, fullConfig.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: class DummyWebSocket {} as any },
      });
      const [{ data: gainers }, { data: losers }] = await Promise.all([
        supabase.from('top_gainers').select('report_url'),
        supabase.from('top_losers').select('report_url'),
      ]);
      const urls = [...(gainers ?? []), ...(losers ?? [])].map(r => r.report_url).filter(Boolean);
      const paths = [...new Set(urls.map(u => new URL(u).pathname.slice(1)))];
      console.log(`Found ${paths.length} existing reports to overwrite/purge...`);
      const result = await purgeReportStorage(config, fetch, { paths });
      console.log(`Successfully overwritten/purged ${result.purged} page(s) in Cloudflare Workers KV.`);
      console.log('To enable instant KV namespace purging, redeploy the Cloudflare Worker.');
    } catch (fallbackError) {
      console.error('Fallback purge failed:', fallbackError);
      process.exit(1);
    }
  } else {
    console.error('Purge failed:', error);
    process.exit(1);
  }
}
