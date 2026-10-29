import 'dotenv/config';
import { runAgentBootstrap } from './bootstrap.js';

async function main(): Promise<void> {
  await runAgentBootstrap();
}

void main().catch((error) => {
  console.error('Run failed with error:', error);
  if (error instanceof Error) {
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
  }
  process.exitCode = 1;
});
