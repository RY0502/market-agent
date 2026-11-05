import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { normalizeSubmissionArguments } from './schema-diagnostics.js';

const assessmentTool = 'submit_stock_assessment';
const envelopeSchema = z.object({
  name: z.literal(assessmentTool), arguments: z.unknown(),
}).strict();

function responseText(response: AIMessage): string {
  return typeof response.content === 'string' ? response.content : response.content.flatMap(block =>
    typeof block === 'object' && block.type === 'text' && 'text' in block && typeof block.text === 'string'
      ? [block.text] : []).join('\n');
}

export function assessmentResponseShape(response: AIMessage) {
  return {
    toolCalls: response.tool_calls?.length ?? 0,
    assessmentCalls: response.tool_calls?.filter(call => call.name === assessmentTool).length ?? 0,
    invalidToolCalls: response.invalid_tool_calls?.length ?? 0,
    invalidAssessmentCalls: response.invalid_tool_calls?.filter(call => call.name === assessmentTool).length ?? 0,
    textChars: responseText(response).length,
  };
}

export interface AssessmentResponseOptions {
  schema?: z.AnyZodObject;
  symbol?: string;
}

/** Never infer a decision from prose or choose between competing assessments. */
export function selectAssessmentResponse(response: AIMessage, options: AssessmentResponseOptions = {}) {
  const calls = response.tool_calls ?? [];
  const assessments = calls.filter(call => call.name === assessmentTool);
  const invalid = response.invalid_tool_calls?.filter(call => call.name === assessmentTool) ?? [];
  if (assessments.length + invalid.length > 1) return undefined;
  if (assessments.length === 1) {
    const discarded = calls.length - 1 + (response.invalid_tool_calls?.length ?? 0);
    return {
      response: discarded ? new AIMessage({ ...response, tool_calls: [assessments[0]!], invalid_tool_calls: [] }) : response,
      format: discarded ? 'bundled_tool_calls' : 'tool_call',
      synthesized: false, discarded,
    };
  }
  if (!options.schema) return undefined;
  // A separate native tool request must run normally, not be replaced by text.
  if (calls.length && !invalid.length) return undefined;
  const raw = invalid.length ? invalid[0]!.args : responseText(response).trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  if (!raw || raw.length > 64_000) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  if (!invalid.length) {
    const envelope = envelopeSchema.safeParse(value);
    if (envelope.success) value = envelope.data.arguments;
  }
  const { args } = normalizeSubmissionArguments(value, options.schema);
  const parsed = options.schema.safeParse(args);
  if (!parsed.success || options.symbol && parsed.data.symbol !== options.symbol) return undefined;
  const discarded = calls.length + (response.invalid_tool_calls?.length ?? 0) - invalid.length;
  return {
    response: new AIMessage({
      ...response, content: '',
      tool_calls: [{
        name: assessmentTool, id: invalid[0]?.id || `assessment_${randomUUID()}`,
        type: 'tool_call', args: parsed.data,
      }],
      invalid_tool_calls: [],
    }),
    format: invalid.length ? 'invalid_tool_call_json' : 'structured_json',
    synthesized: true, discarded,
  };
}
