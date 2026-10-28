import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { monthsBefore } from './dates.js';

export async function atomicWrite(file: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function initializeStorage(root: string): Promise<void> {
  await Promise.all(['bhav', 'reduced', 'runs'].map(dir => mkdir(path.join(root, dir), { recursive: true })));
}

export async function removeOptional(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function cleanupRun(root: string, date: string, runId: string): Promise<void> {
  await removeOptional(path.join(root, 'reduced', `${date}.json`));
  for (const entry of await readdir(path.join(root, 'runs'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(`.${runId}.jsonl`) || entry.name === `${runId}.publication.json`)) {
      await removeOptional(path.join(root, 'runs', entry.name));
    }
  }
}

export async function prune(root: string, today: string): Promise<void> {
  const cutoff = monthsBefore(today, 2);
  for (const dir of ['bhav']) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:\.[a-zA-Z0-9-]+)*\.(?:csv|json|jsonl|tmp)$/.exec(entry.name);
      if (entry.isFile() && match?.[1] && match[1] < cutoff) {
        await unlink(path.join(root, dir, entry.name));
      }
    }
  }
}
