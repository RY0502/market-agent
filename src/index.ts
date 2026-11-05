import 'dotenv/config';
import { reportBootstrapFailure, runAgentBootstrap } from './bootstrap.js';

async function main(): Promise<void> {
  await runAgentBootstrap();
}

void main().catch(reportBootstrapFailure);
