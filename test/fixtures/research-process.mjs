import { writeFileSync } from 'node:fs';

process.once('message', input => {
  if (input.pidFile) writeFileSync(input.pidFile, String(process.pid));
  if (input.action === 'result') process.send({ type: 'result', result: { pid: process.pid } });
  if (input.action === 'error') process.send({ type: 'error', error: 'Fixture research failure' });
  if (input.action === 'exit') process.exit(1);
  setInterval(() => {}, 1000);
});
