import { randomUUID } from 'node:crypto';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BhavStore, MissingBhavcopy, UnavailableHistory, screen } from './bhav.js';
import { dateValue, todayIST } from './dates.js';
import { atomicWrite, cleanupRun, initializeStorage, prune, readOptional } from './storage.js';
import { selectStocks, refreshClassification, type RankedStock, type Researcher } from './research.js';
import type { Publisher } from './publish.js';
import { loadScreeningConfig, type ScreeningConfig } from './screening.js';

export interface Job {
  id: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'publishing' | 'completed' | 'skipped' | 'failed';
  phase: string;
  error?: string;
  skippedReason?: string;
  baselineDate?: string;
  downloads?: number;
  missingDates?: string[];
  settings: ScreeningConfig;
  candidates?: { gainers: number; losers: number };
  results?: { gainers: RankedStock[]; losers: RankedStock[] };
  inserted?: { gainers: number; losers: number };
}
export class BusyError extends Error {}

export interface JobDependencies {
  root: string;
  researcher: (runId: string) => Researcher;
  publish: Publisher;
  request?: typeof fetch;
  screeningConfig?: () => ScreeningConfig;
}

export class Jobs {
  private active?: string;
  private inFlight?: Promise<void>;
  constructor(private deps: JobDependencies) {}

  async initialize(): Promise<void> {
    await initializeStorage(this.deps.root);
    if (await readOptional(path.join(this.deps.root, '.run.lock'))) {
      console.warn('An existing disk run lock was found; leaving prior run records unchanged.');
      return;
    }
    // A prior crash may have left queued/running jobs, but must never trigger automatic publication.
    for (const file of await readdir(path.join(this.deps.root, 'runs'))) {
      if (!/^\d{4}-\d{2}-\d{2}\.[a-f0-9-]{36}\.json$/.test(file)) continue;
      const contents = await readOptional(path.join(this.deps.root, 'runs', file));
      const job = JSON.parse(contents!.toString()) as Job;
      if (['queued', 'running', 'publishing'].includes(job.status)) {
        job.status = 'failed';
        job.error = 'Process interrupted. If phase was publishing, inspect disk publication progress and reconcile Supabase rows before retrying; an insert may already have committed.';
        await this.save(job);
      }
    }
  }

  private file(job: Pick<Job, 'id' | 'createdAt'>, extension = 'json'): string {
    return path.join(this.deps.root, 'runs', `${todayIST(new Date(job.createdAt))}.${job.id}.${extension}`);
  }

  private async save(job: Job): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await atomicWrite(this.file(job), JSON.stringify(job, null, 2));
  }

  async start(date = todayIST()): Promise<Job> {
    dateValue(date);
    if (date > todayIST()) throw new Error('Analysis date cannot be in the future');
    if (this.active) throw new BusyError(`Run ${this.active} is already active`);
    const settings = (this.deps.screeningConfig ?? loadScreeningConfig)();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const job: Job = { id, date, createdAt, updatedAt: createdAt, settings, status: 'queued', phase: 'queued' };
    this.active = id;
    try {
      await writeFile(path.join(this.deps.root, '.run.lock'), JSON.stringify({ id, pid: process.pid, createdAt }), {
        flag: 'wx', mode: 0o600,
      });
    } catch (error) {
      this.active = undefined;
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new BusyError('Disk run lock exists. Another process may be running; inspect data/.run.lock before removing a stale lock.');
      }
      throw error;
    }
    try {
      await this.save(job);
    } catch (error) {
      this.active = undefined;
      await unlink(path.join(this.deps.root, '.run.lock'));
      throw error;
    }
    const response = { ...job };
    this.inFlight = this.execute(job).finally(async () => {
      await unlink(path.join(this.deps.root, '.run.lock'));
      this.active = undefined;
    }).catch(error => {
      console.error(JSON.stringify({ event: 'job_persistence_error', runId: id, error: String(error) }));
    });
    return response;
  }

  async wait(): Promise<void> {
    await this.inFlight;
  }

  async get(id: string): Promise<Job | undefined> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return undefined;
    const files = await readdir(path.join(this.deps.root, 'runs'));
    const file = files.find(name => name.endsWith(`.${id}.json`));
    if (!file) return undefined;
    const contents = await readOptional(path.join(this.deps.root, 'runs', file));
    return contents ? JSON.parse(contents.toString()) as Job : undefined;
  }

  private async execute(job: Job): Promise<void> {
    const store = new BhavStore(this.deps.root, this.deps.request);
    try {
      job.status = 'running';
      job.phase = 'downloading';
      await this.save(job);
      await prune(this.deps.root, todayIST());
      const history = await store.history(job.date, job.settings);
      job.baselineDate = history.baseline;
      if (store.missingDates.length) {
        console.warn(JSON.stringify({
          event: 'missing_archive_dates', runId: job.id, dates: store.missingDates,
          explanation: 'NSE returned 404; these dates are omitted, not assumed to be confirmed holidays.',
        }));
      }
      const candidates = screen(history, job.settings);
      job.downloads = store.downloads;
      job.missingDates = store.missingDates;
      job.candidates = {
        gainers: candidates.filter(c => c.group === 'gainers').length,
        losers: candidates.filter(c => c.group === 'losers').length,
      };
      job.phase = 'researching';
      await this.save(job);
      const results = await selectStocks(candidates, this.deps.researcher(job.id), async (candidate, research) => {
        console.log(JSON.stringify({
          event: 'stock_assessment', runId: job.id, symbol: candidate.symbol,
          group: candidate.group, profitProbability: research.assessment.profitProbability,
          reasons: research.assessment.reasons, risks: research.assessment.risks,
          classificationReason: research.assessment.classificationReason, dataGapReason: research.assessment.dataGapReason,
        }));
      });
      for (const stock of [...results.gainers, ...results.losers]) {
        refreshClassification(stock);
      }
      job.results = results;
      job.status = 'publishing';
      job.phase = 'publishing';
      await this.save(job);
      await this.deps.publish(results, job.id);
      job.status = 'completed';
      job.phase = 'cleaning';
      job.inserted = { gainers: results.gainers.length, losers: results.losers.length };
      delete job.results;
      await this.save(job);
      await cleanupRun(this.deps.root, job.date, job.id);
      job.phase = 'completed';
      await this.save(job);
      console.log(JSON.stringify({ event: 'run_completed', runId: job.id, gainers: results.gainers.length, losers: results.losers.length }));
    } catch (error) {
      job.downloads = store.downloads;
      job.missingDates = store.missingDates;
      if (error instanceof MissingBhavcopy || error instanceof UnavailableHistory) {
        job.status = 'skipped';
        job.phase = 'skipped';
        job.skippedReason = error.message;
        await this.save(job);
        console.info(JSON.stringify({ event: 'run_skipped', runId: job.id, date: job.date, reason: job.skippedReason }));
      } else {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        await this.save(job);
        console.error(JSON.stringify({ event: 'run_failed', runId: job.id, phase: job.phase, error: job.error }));
      }
    } finally {
      await prune(this.deps.root, todayIST());
    }
  }
}
