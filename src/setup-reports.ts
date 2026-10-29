import { loadReportConfig } from './config.js';
import { verifyReportHosting } from './report-storage.js';

await verifyReportHosting(loadReportConfig());
console.log('Verified Cloudflare Worker and KV binding with five-day report retention.');
