import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_SQL } from 'freetier-deepagent-framework';
import { RESET_FRAMEWORK_SQL } from '../src/neon.js';

test('Neon reset clears all framework state atomically without deleting tables or unrelated data', async () => {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA_SQL);
    await db.exec(`
      CREATE TABLE unrelated (id integer PRIMARY KEY);
      INSERT INTO unrelated VALUES (1);
      INSERT INTO agent_runs (prompt_hash, user_prompt, thread_id) VALUES ('old', 'old task', 'old');
      INSERT INTO agent_todos (prompt_hash, todo_index, content) VALUES ('old', 0, 'old');
      INSERT INTO agent_events (prompt_hash, event_type) VALUES ('old', 'old');
      INSERT INTO agent_custom_state (prompt_hash, state_key, value) VALUES ('old', 'old', '{}');
      INSERT INTO checkpoints (thread_id, checkpoint_id, checkpoint) VALUES ('old', 'old', '{}');
      INSERT INTO checkpoint_writes (thread_id, checkpoint_id, task_id, idx, channel, value)
        VALUES ('old', 'old', 'old', 0, 'old', '{}');
    `);
    for (let run = 0; run < 2; run++) {
      await db.exec(RESET_FRAMEWORK_SQL);
      for (const table of ['agent_runs', 'agent_todos', 'agent_events', 'agent_custom_state', 'checkpoints', 'checkpoint_writes']) {
        assert.deepEqual((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows, [{ count: 0 }]);
      }
    }
    assert.deepEqual((await db.query('SELECT * FROM unrelated')).rows, [{ id: 1 }]);
    await db.exec("INSERT INTO agent_runs (prompt_hash, user_prompt, thread_id) VALUES ('new', 'new task', 'new')");
    await db.exec("CREATE TABLE external_reference (prompt_hash text REFERENCES agent_runs(prompt_hash))");
    await db.exec("INSERT INTO external_reference VALUES ('new')");
    await assert.rejects(db.exec(RESET_FRAMEWORK_SQL));
    assert.deepEqual((await db.query('SELECT prompt_hash FROM agent_runs')).rows, [{ prompt_hash: 'new' }]);
  } finally { await db.close(); }
});
