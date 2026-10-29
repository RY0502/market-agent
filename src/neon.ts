import type { DatabaseClient } from 'freetier-deepagent-framework';

export const RESET_FRAMEWORK_SQL = `
TRUNCATE TABLE public.agent_todos, public.agent_events, public.agent_custom_state,
  public.checkpoint_writes, public.checkpoints, public.agent_runs RESTART IDENTITY
`;

export async function resetFrameworkState(db: DatabaseClient): Promise<void> {
  await db.getSql()(RESET_FRAMEWORK_SQL);
}
