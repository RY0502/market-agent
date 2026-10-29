import { z } from 'zod';
import { normalizeMetricText } from './financial-metrics.js';

export const metricFields = ['livePrice', 'pe', 'sectorPe', 'marketCapCrore', 'debtToEquity', 'earningsGrowthPercent'] as const;

export function normalizeSubmissionArguments(input: unknown, schema: z.ZodType) {
  const conversions: {
    field: string; from: 'string'; to: 'number' | 'null' | 'string';
    reason: 'decimal_string' | 'unit_or_format' | 'missing_value' | 'missing_classified_reason' | 'provider_null_token' | 'category_format' | 'supporting_reason';
  }[] = [];
  if (!(schema instanceof z.ZodObject)) throw new Error('Submission normalization requires an object schema');
  const parsed = z.record(z.unknown()).safeParse(input);
  if (!parsed.success) return { args: input, conversions };
  const args = { ...parsed.data };
  const normalizeNone = (value: unknown, fieldSchema: z.ZodTypeAny, field: string): unknown => {
    if (value === 'None' && fieldSchema.isNullable()) {
      conversions.push({ field, from: 'string', to: 'null', reason: 'provider_null_token' });
      return null;
    }
    while (fieldSchema instanceof z.ZodNullable || fieldSchema instanceof z.ZodOptional || fieldSchema instanceof z.ZodDefault) {
      fieldSchema = fieldSchema instanceof z.ZodDefault ? fieldSchema.removeDefault() : fieldSchema.unwrap();
    }
    if (fieldSchema instanceof z.ZodObject) {
      const object = z.record(z.unknown()).safeParse(value);
      if (object.success) {
        const shape = fieldSchema.shape;
        return Object.fromEntries(Object.entries(object.data).map(([key, item]) => [
          key, shape[key] ? normalizeNone(item, shape[key], `${field}.${key}`) : item,
        ]));
      }
    }
    return value;
  };
  for (const [field, value] of Object.entries(args)) {
    if (schema.shape[field]) args[field] = normalizeNone(value, schema.shape[field], field);
  }
  if (typeof args.profitProbability === 'string') {
    const category = args.profitProbability.trim().toLowerCase();
    if (['low', 'medium', 'high'].includes(category) && args.profitProbability !== category) {
      args.profitProbability = category;
      conversions.push({ field: 'profitProbability', from: 'string', to: 'string', reason: 'category_format' });
    } else if (['unsure', 'unknown', 'null', 'none'].includes(category)) {
      args.profitProbability = null;
      conversions.push({ field: 'profitProbability', from: 'string', to: 'null', reason: 'missing_value' });
    }
  }
  if (typeof args.classificationReason === 'string' && args.classificationReason.trim().length < 20 &&
      Array.isArray(args.reasons)) {
    const supporting = args.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length >= 20);
    if (supporting.length) {
      args.classificationReason = [args.classificationReason.trim(), supporting[0]].filter(Boolean).join('. ');
      conversions.push({ field: 'classificationReason', from: 'string', to: 'string', reason: 'supporting_reason' });
    }
  }
  for (const field of metricFields) {
    const value = args[field];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (['', 'null', 'n/a', 'na', 'unknown', 'unverified', 'not available'].includes(text.toLowerCase())) {
      args[field] = null;
      conversions.push({ field, from: 'string', to: 'null', reason: 'missing_value' });
    } else {
      const number = normalizeMetricText(field, text);
      if (number === undefined) continue;
      args[field] = number;
      conversions.push({
        field, from: 'string', to: 'number',
        reason: /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? 'decimal_string' : 'unit_or_format',
      });
    }
  }
  if (typeof args.profitProbability === 'string' && ['low', 'medium', 'high'].includes(args.profitProbability) &&
      typeof args.dataGapReason === 'string' && ['', 'null'].includes(args.dataGapReason.trim().toLowerCase())) {
    args.dataGapReason = null;
    conversions.push({ field: 'dataGapReason', from: 'string', to: 'null', reason: 'missing_classified_reason' });
  }
  return { args, conversions };
}

export function schemaIssueDetails(schema: z.ZodType, input: unknown, issues: z.ZodIssue[]) {
  return issues.map(issue => {
    let value: unknown = input;
    let field: z.ZodTypeAny | undefined = schema;
    for (const part of issue.path) {
      value = value !== null && typeof value === 'object' && Object.hasOwn(value, part)
        ? Reflect.get(value, part) : undefined;
      while (field instanceof z.ZodNullable || field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
        field = field instanceof z.ZodDefault ? field.removeDefault() : field.unwrap();
      }
      field = field instanceof z.ZodObject ? field.shape[part] :
        field instanceof z.ZodArray ? field.element :
        field instanceof z.ZodRecord ? field.valueSchema : undefined;
    }
    return {
      path: issue.path.join('.'), code: issue.code,
      expected: issue.code === 'invalid_type' ? issue.expected : field?.description ?? 'schema constraints',
      received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      keys: value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).sort().slice(0, 20) : undefined,
      hint: field?.description,
    };
  });
}
