import type { DatabaseClient } from 'freetier-deepagent-framework';
import { neonConfig } from '@neondatabase/serverless';

export function createRetryingFetch(
  baseFetch: typeof fetch = fetch,
  maxAttempts = 3,
  delayMs = 500
): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await baseFetch(url, init);
      } catch (err) {
        lastError = err;
        const isNetworkError =
          err instanceof TypeError ||
          (err instanceof Error &&
            (err.message.includes('fetch failed') ||
              err.message.includes('ECONNRESET') ||
              err.message.includes('ETIMEDOUT') ||
              err.message.includes('undici')));
        if (!isNetworkError || attempt === maxAttempts) throw err;
        await new Promise(resolve => setTimeout(resolve, attempt * delayMs));
      }
    }
    throw lastError;
  };
}

export function configureNeonRetries(baseFetch: typeof fetch = fetch): void {
  neonConfig.fetchFunction = createRetryingFetch(baseFetch);
}

configureNeonRetries();

export const RESET_FRAMEWORK_SQL = `
TRUNCATE TABLE public.agent_todos, public.agent_events, public.agent_custom_state,
  public.checkpoint_writes, public.checkpoints, public.agent_runs RESTART IDENTITY
`;

export async function resetFrameworkState(db: DatabaseClient): Promise<void> {
  await db.getSql()(RESET_FRAMEWORK_SQL);
}
