import { fork } from 'node:child_process';
import { ResearchLimitError } from './research-control.js';

// Terminating the isolated process also stops requests in tools that ignore AbortSignal.
export function runResearchProcess<T>(entry: URL, input: object, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result: T;
    let received = false;
    let failure: Error | undefined;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      failure ??= error;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => finish(
      new ResearchLimitError(`Per-stock research deadline exceeded (${timeoutMs} ms)`),
    ), timeoutMs);
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        finish(new Error('Invalid research worker response'));
      } else if (message.type === 'result' && 'result' in message) {
        result = message.result as T;
        received = true;
        finish();
      } else if (message.type === 'error' && 'error' in message && typeof message.error === 'string') {
        finish(new Error(message.error));
      } else {
        finish(new Error('Invalid research worker response'));
      }
    });
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (received) resolve(result);
      else reject(new Error(`Research worker exited without a result (code=${code}, signal=${signal})`));
    });
    child.send(input, error => { if (error) finish(error); });
  });
}
