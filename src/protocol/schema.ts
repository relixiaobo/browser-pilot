import { invalidArgument } from './errors.js';
import type { JsonValue } from './model.js';

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  $schema?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaType;
  const?: JsonValue;
  enum?: JsonValue[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
  }
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}

export function validateSchemaValue(
  schema: JsonSchema,
  value: unknown,
  path = '$',
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  if (schema.oneOf) {
    const alternatives = schema.oneOf.map(candidate => validateSchemaValue(candidate, value, path));
    const matches = alternatives.filter(candidateIssues => candidateIssues.length === 0);
    if (matches.length !== 1) {
      issues.push({ path, message: `must match exactly one schema alternative; matched ${matches.length}` });
    }
    return issues;
  }

  if (schema.const !== undefined && !jsonEquals(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.some(item => jsonEquals(value, item))) {
    issues.push({ path, message: `must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}` });
  }

  if (schema.type && !matchesType(value, schema.type)) {
    issues.push({ path, message: `must be ${schema.type}` });
    return issues;
  }

  if (schema.type === 'object' && isRecord(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        issues.push({ path: joinPath(path, required), message: 'is required' });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        issues.push(...validateSchemaValue(propertySchema, child, joinPath(path, key)));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: joinPath(path, key), message: 'is not allowed' });
      } else if (isRecord(schema.additionalProperties)) {
        issues.push(...validateSchemaValue(schema.additionalProperties, child, joinPath(path, key)));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `must contain no more than ${schema.maxItems} item(s)` });
    }
    if (schema.uniqueItems) {
      const serialized = value.map(item => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        issues.push({ path, message: 'must contain unique items' });
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateSchemaValue(schema.items!, item, joinPath(path, index)));
      });
    }
  }

  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} character(s)` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must be no more than ${schema.maxLength} character(s)` });
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push({ path, message: `must match ${schema.pattern}` });
    }
  }

  if ((schema.type === 'number' || schema.type === 'integer') && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be no more than ${schema.maximum}` });
    }
  }

  return issues;
}

export function assertSchemaValue(schema: JsonSchema, value: unknown, field = 'arguments'): void {
  const issues = validateSchemaValue(schema, value);
  if (issues.length === 0) return;
  const summary = issues.slice(0, 5).map(issue => `${issue.path} ${issue.message}`).join('; ');
  const suffix = issues.length > 5 ? `; ${issues.length - 5} more issue(s)` : '';
  throw invalidArgument(`Invalid ${field}: ${summary}${suffix}`, field);
}

export function assertSchemaDefinition(schema: JsonSchema, path = '$schema'): void {
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(properties, required)) {
        throw new Error(`${path}.required references unknown property ${required}`);
      }
    }
    for (const [name, property] of Object.entries(properties)) {
      assertSchemaDefinition(property, `${path}.properties.${name}`);
    }
    if (isRecord(schema.additionalProperties)) {
      assertSchemaDefinition(schema.additionalProperties, `${path}.additionalProperties`);
    }
  }
  if (schema.type === 'array' && schema.items) {
    assertSchemaDefinition(schema.items, `${path}.items`);
  }
  for (const [index, alternative] of (schema.oneOf ?? []).entries()) {
    assertSchemaDefinition(alternative, `${path}.oneOf[${index}]`);
  }
  if (schema.pattern) new RegExp(schema.pattern, 'u');
}

export const stringSchema = (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({ type: 'string', ...options });
export const booleanSchema = (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({ type: 'boolean', ...options });
export const integerSchema = (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({ type: 'integer', ...options });
export const numberSchema = (options: Omit<JsonSchema, 'type'> = {}): JsonSchema => ({ type: 'number', ...options });
export const arraySchema = (items: JsonSchema, options: Omit<JsonSchema, 'type' | 'items'> = {}): JsonSchema => ({
  type: 'array',
  items,
  ...options,
});
export const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  options: Omit<JsonSchema, 'type' | 'properties' | 'required'> = {},
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...options,
});
