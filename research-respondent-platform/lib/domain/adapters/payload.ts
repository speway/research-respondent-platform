/**
 * Field → payload projection shared by the execution adapters.
 *
 * A field is either mapped (it carries a value with recorded provenance) or
 * explicitly unmapped (`valueKind: "none"`). Anything in between is a contract
 * defect, and a required field with no documented source blocks the payload.
 */
import type { AgentTaskContract } from "../types.ts";

export interface FieldSummary {
  fieldId: string;
  fieldTitle: string;
  required: boolean;
  valueKind: string;
  value: string | null;
  provenance: string;
  mapped: boolean;
  explicitlyUnmapped: boolean;
  status: "pass" | "warn" | "fail";
  issueCodes: string[];
}

export interface FieldCounts {
  total: number;
  mapped: number;
  unmappedRequired: number;
  unmappedOptional: number;
  pass: number;
  warn: number;
  fail: number;
}

/** Deterministic: insertion order follows `fieldMap` order. */
export function composePayload(contract: AgentTaskContract): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of contract.fieldMap) {
    if (field.value !== null) payload[field.fieldId] = field.value;
  }
  return payload;
}

export function summarizeFields(contract: AgentTaskContract): FieldSummary[] {
  return contract.fieldMap.map((field) => {
    const base = {
      fieldId: field.fieldId,
      fieldTitle: field.fieldTitle,
      required: field.required,
      valueKind: field.valueKind,
      value: field.value,
      provenance: field.provenance,
      mapped: field.value !== null,
      explicitlyUnmapped: field.value === null && field.valueKind === "none",
    };
    if (field.value !== null) return { ...base, status: "pass" as const, issueCodes: [] as string[] };
    if (!base.explicitlyUnmapped) {
      return { ...base, status: "fail" as const, issueCodes: ["field.value_kind_without_value"] };
    }
    if (field.required) {
      return { ...base, status: "fail" as const, issueCodes: ["field.required_without_documented_source"] };
    }
    return { ...base, status: "warn" as const, issueCodes: ["field.optional_without_documented_source"] };
  });
}

export function countFields(fields: FieldSummary[]): FieldCounts {
  const count = (status: FieldSummary["status"]) => fields.filter((field) => field.status === status).length;
  const unmapped = fields.filter((field) => !field.mapped);
  return {
    total: fields.length,
    mapped: fields.length - unmapped.length,
    unmappedRequired: unmapped.filter((field) => field.required).length,
    unmappedOptional: unmapped.filter((field) => !field.required).length,
    pass: count("pass"),
    warn: count("warn"),
    fail: count("fail"),
  };
}

export function blockingFieldReasons(fields: FieldSummary[]): string[] {
  return fields
    .filter((field) => field.status === "fail")
    .map((field) => `${field.fieldId} (${field.fieldTitle}): ${field.issueCodes.join(", ")}`);
}
