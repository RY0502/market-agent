import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { BusyError, Jobs } from './jobs.js';
import { dateValue, todayIST } from './dates.js';

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let contents = '';
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 1024) throw new Error('Request body exceeds 1024 bytes');
    contents += chunk.toString();
  }
  return contents.trim() ? JSON.parse(contents) : {};
}

export function createHttpServer(jobs: Jobs) {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        respond(response, 200, { status: 'ok' });
      } else if (request.method === 'POST' && url.pathname === '/runs') {
        let input: { date?: string };
        try {
          input = z.object({ date: z.string().optional() }).strict().parse(await body(request));
          if (input.date) dateValue(input.date);
          if (input.date && input.date > todayIST()) throw new Error('Analysis date cannot be in the future');
        } catch (error) {
          respond(response, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const job = await jobs.start(input.date);
        respond(response, 202, { ...job, statusUrl: `/runs/${job.id}` });
      } else if (request.method === 'GET' && /^\/runs\/[a-f0-9-]+$/.test(url.pathname)) {
        const job = await jobs.get(url.pathname.slice('/runs/'.length));
        respond(response, job ? 200 : 404, job ?? { error: 'Run not found' });
      } else {
        respond(response, 404, { error: 'Route not found' });
      }
    })().catch(error => {
      console.error(JSON.stringify({ event: 'http_error', error: String(error) }));
      if (!response.headersSent) respond(response, error instanceof BusyError ? 409 : 500, {
        error: error instanceof BusyError ? error.message : 'Internal server error; see server logs',
      });
      else response.end();
    });
  });
}
