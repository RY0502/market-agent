import { CONFIG, DatabaseClient, validateConfig } from 'freetier-deepagent-framework';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { Jobs } from './jobs.js';
import { createResearcher } from './research.js';
import { createPublisher } from './publish.js';
import { resetFrameworkState } from './neon.js';
import { createReporter, verifyReportHosting } from './report-storage.js';

const config = loadConfig();
validateConfig();
await verifyReportHosting(config);
const db = new DatabaseClient(CONFIG.NEON_DATABASE_URL);
const jobs = new Jobs({
  root: config.DATA_DIR,
  researcher: id => createResearcher(config.DATA_DIR, id),
  resetFrameworkState: () => resetFrameworkState(db),
  publish: createPublisher(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, config.DATA_DIR),
  report: createReporter(config),
});
await jobs.initialize();
const server = createHttpServer(jobs);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(config.PORT, config.HOST, () => {
  console.log(`Unauthenticated NSE research API listening on http://${config.HOST}:${config.PORT}`);
  console.warn('Anyone with network access can clear dedicated Neon framework state, trigger paid/quota-consuming research, append results and prune history. Do not expose this port to the public internet.');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void jobs.wait().catch(error => {
        console.error(error);
        process.exitCode = 1;
      }).finally(async () => {
        if (process.env.PAUSE_BASE_URL) {
          try {
            const { pauseVm } = await import('./services/vmPauseService.js');
            await pauseVm();
          } catch (pauseError) {
            console.error('VM pause failed on server shutdown:', pauseError);
          }
        }
      });
    });
  });
}
