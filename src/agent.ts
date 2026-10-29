import { CONFIG, DatabaseClient, validateConfig } from 'freetier-deepagent-framework';
import { loadConfig } from './config.js';
import { Jobs, type Job } from './jobs.js';
import { createResearcher } from './research.js';
import { createPublisher } from './publish.js';
import { resetFrameworkState } from './neon.js';
import { createReporter, verifyReportHosting } from './report-storage.js';
import { todayIST } from './dates.js';

export interface RunAgentOptions {
  date?: string;
  config?: ReturnType<typeof loadConfig>;
}

export async function runAgent(options: RunAgentOptions = {}): Promise<Job> {
  const config = options.config ?? loadConfig();
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
  const date = options.date ?? process.argv[2] ?? todayIST();
  console.log(`Starting market research agent for date: ${date}`);
  const startedJob = await jobs.start(date);
  await jobs.wait();
  const finishedJob = (await jobs.get(startedJob.id)) ?? startedJob;
  if (finishedJob.status === 'failed') {
    throw new Error(finishedJob.error || 'Job failed');
  }
  return finishedJob;
}
