import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import { z } from 'zod';
import { normalizeSubmissionArguments, schemaIssueDetails } from './schema-diagnostics.js';

export const researchLimitsSchema = z.object({
  RESEARCH_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(360_000),
  RESEARCH_MAX_MODEL_CALLS: z.coerce.number().int().positive().default(20),
  RESEARCH_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(40),
});
export type ResearchLimits = z.infer<typeof researchLimitsSchema>;
export class ResearchLimitError extends Error {
  name = 'ResearchLimitError';
}

export function isResearchNetworkError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const code = 'code' in error ? error.code : undefined;
  const status = 'status' in error ? error.status : undefined;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'ResearchLimitError')) return false;
  if (typeof status === 'number') return [408, 502, 503, 504].includes(status);
  if (typeof code === 'string' && [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  ].includes(code)) return true;
  if (error instanceof Error && (
    error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError' ||
    (error instanceof TypeError && /^(fetch failed|failed to fetch|networkerror)/i.test(error.message))
  )) return true;
  return 'cause' in error && isResearchNetworkError(error.cause, depth + 1);
}

export async function retryResearchNetwork<T>(
  operation: () => PromiseLike<T> | T, diagnostics: ResearchDiagnostics, operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isResearchNetworkError(error)) throw error;
    diagnostics.event('research_network_retry', {
      operation: operationName, attempt: 2, errorType: error instanceof Error ? error.name : 'NetworkError',
    });
    return operation();
  }
}

export class ResearchDiagnostics extends BaseCallbackHandler {
  name = 'nse-research-diagnostics';
  private modelCalls = 0;
  private toolCalls = 0;
  private submissions = 0;
  private active = new Map<string, { tool: string; started: number }>();
  private activeModels = new Map<string, { started: number; modelCall: number }>();
  private failure?: ResearchLimitError;

  constructor(
    private context: { runId: string; symbol: string },
    private limits: ResearchLimits,
    private submissionSchema: z.ZodType,
    private onLimit: (error: ResearchLimitError) => void,
    private log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event)),
  ) {
    super({ _awaitHandler: true, raiseError: true });
  }

  event(event: string, details: Record<string, unknown> = {}): void {
    this.log({ event, ...this.context, ...details });
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.modelCalls > this.limits.RESEARCH_MAX_MODEL_CALLS ||
        this.toolCalls > this.limits.RESEARCH_MAX_TOOL_CALLS) {
      this.stop('Per-stock research budget exhausted');
    }
  }

  stop(reason: string): never {
    if (!this.failure) {
      this.failure = new ResearchLimitError(reason);
      this.event('research_limit_exceeded', {
        modelCalls: this.modelCalls, toolCalls: this.toolCalls, submissions: this.submissions,
      });
      this.onLimit(this.failure);
    }
    throw this.failure;
  }

  handleLLMStart(_llm?: Serialized, _prompts?: string[], runId?: string): void {
    this.modelCalls++;
    this.check();
    if (runId) this.activeModels.set(runId, { started: Date.now(), modelCall: this.modelCalls });
    this.event('research_model_start', { modelCalls: this.modelCalls, modelRunId: runId });
  }

  requestTool(tool: string, toolCallId?: string): void {
    this.toolCalls++;
    this.event('research_tool_requested', { tool, toolCallId, toolCalls: this.toolCalls });
    this.check();
  }

  handleLLMEnd(output: LLMResult, runId?: string): void {
    this.finishModel('research_model_end', runId);
    const schema = z.object({
      message: z.object({ tool_calls: z.array(z.object({
        name: z.string(), id: z.string().optional(), args: z.unknown(),
      })).optional() }),
    });
    for (const generations of output.generations) {
      for (const generation of generations) {
        const parsed = schema.safeParse(generation);
        for (const call of parsed.success ? parsed.data.message.tool_calls ?? [] : []) {
          if (call.name === 'submit_stock_assessment') this.submissions++;
          this.requestTool(call.name, call.id);
          if (call.name === 'submit_stock_assessment') {
            const { args } = normalizeSubmissionArguments(call.args, this.submissionSchema);
            const result = this.submissionSchema.safeParse(args);
            if (!result.success) this.event('assessment_schema_warning', {
              submission: this.submissions,
              issues: schemaIssueDetails(this.submissionSchema, args, result.error.issues),
            });
          }
          this.check();
        }
      }

    }
  }

  handleLLMError(error: Error, runId: string): void {
    this.finishModel('research_model_error', runId, error);
  }

  private finishModel(event: string, runId?: string, error?: Error): void {
    const active = runId ? this.activeModels.get(runId) : undefined;
    if (runId) this.activeModels.delete(runId);
    this.event(event, {
      modelRunId: runId, modelCall: active?.modelCall,
      durationMs: active ? Date.now() - active.started : undefined,
      errorType: error?.name,
    });
  }

  handleToolStart(tool: Serialized, _input: string, runId: string,
    _parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string): void {
    this.check();
    const name = runName ?? ('name' in tool && typeof tool.name === 'string' ? tool.name : 'unknown');
    this.active.set(runId, { tool: name, started: Date.now() });
    this.event('research_tool_start', { tool: name, toolRunId: runId });
  }

  handleToolEnd(_output: unknown, runId: string): void {
    const active = this.active.get(runId);
    this.active.delete(runId);
    this.event('research_tool_end', {
      tool: active?.tool, toolRunId: runId, durationMs: active ? Date.now() - active.started : undefined,
    });
  }

  handleToolError(error: unknown, runId: string): void {
    const active = this.active.get(runId);
    this.active.delete(runId);
    this.event('research_tool_error', {
      tool: active?.tool, toolRunId: runId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
