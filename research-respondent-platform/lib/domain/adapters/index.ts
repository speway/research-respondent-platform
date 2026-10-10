/**
 * Adapter registry: the single entry point the service layer imports.
 *
 * `ADAPTER_REGISTRY` maps the adapter id persisted on `agent.adapter_id` (see
 * the `provider` check constraint in the schema) to a factory. Unknown ids
 * resolve to `undefined` so a caller must handle them explicitly.
 */
import { DomainError } from "../types.ts";
import type { TaskAdapter } from "../types.ts";
import { createLocalDeterministicAdapter } from "./local-deterministic.ts";
import type { LocalDeterministicOptions } from "./local-deterministic.ts";
import { createGoogleFormsAdapter } from "./google-forms.ts";
import type { GoogleFormsConfig } from "./google-forms.ts";

export { createLocalDeterministicAdapter } from "./local-deterministic.ts";
export type { LocalDeterministicOptions } from "./local-deterministic.ts";
export { createGoogleFormsAdapter, GOOGLE_FORMS_SECRET_REF } from "./google-forms.ts";
export type {
  GoogleFormsAdapterOptions,
  GoogleFormsCapabilities,
  GoogleFormsConfig,
  GoogleFormsSubmission,
  GoogleFormsSubmissionReceipt,
  GoogleFormsSubmit,
} from "./google-forms.ts";
export { blockingFieldReasons, composePayload, countFields, summarizeFields } from "./payload.ts";
export type { FieldCounts, FieldSummary } from "./payload.ts";

/** Ids registered here must match `agent.provider` / adapter ids in the schema. */
export type AdapterFactory = (config?: unknown) => TaskAdapter;

export const ADAPTER_REGISTRY: Readonly<Record<string, AdapterFactory>> = Object.freeze({
  "local-deterministic": (config) => createLocalDeterministicAdapter((config ?? {}) as LocalDeterministicOptions),
  "google-forms": (config) => {
    // Fail closed: guessing provider capabilities would be a safety assumption.
    if (config === undefined || config === null) {
      throw new DomainError(
        "adapter.config_required",
        "the google-forms adapter requires an explicit capability config; defaults would assume an authorized submission path",
        { adapterId: "google-forms" },
      );
    }
    return createGoogleFormsAdapter(config as GoogleFormsConfig);
  },
});

/** Throws instead of silently falling back to a different adapter. */
export function resolveAdapter(adapterId: string, config?: unknown): TaskAdapter {
  const factory = ADAPTER_REGISTRY[adapterId];
  if (factory === undefined) {
    throw new DomainError("adapter.unknown", `no adapter registered for id '${adapterId}'`, {
      adapterId,
      knownAdapterIds: Object.keys(ADAPTER_REGISTRY),
    });
  }
  return factory(config);
}
