"use client";

import { useActionState, useRef } from "react";
import type { ActionResult } from "../app/actions/studies.ts";

type Runner = (formData: FormData) => Promise<ActionResult>;

const IDLE: ActionResult = { ok: true, message: "" };

export interface ActionFormProps {
  action: Runner;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
  resetOnSuccess?: boolean;
  confirm?: string;
  quiet?: boolean;
  hidden?: Record<string, string>;
  onResult?: never;
}

/**
 * Thin client wrapper around a server action so every form in the platform gets
 * the same pending state, success message and error surface.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  className,
  resetOnSuccess,
  confirm,
  quiet,
  hidden,
}: ActionFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(async (_previous: ActionResult, formData: FormData) => {
    const result = await action(formData);
    if (result.ok && resetOnSuccess) {
      formRef.current?.reset();
    }
    return result;
  }, IDLE);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className ?? "grid gap-3"}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) {
          event.preventDefault();
        }
      }}
    >
      {hidden
        ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      {children}
      {state.message ? (
        <p className={state.ok ? "note note-ok" : "note note-fail"} role={state.ok ? "status" : "alert"}>
          {state.message}
          {state.detail && !state.ok ? (
            <span className="mono block text-[0.6875rem]">{JSON.stringify(state.detail).slice(0, 400)}</span>
          ) : null}
        </p>
      ) : null}
      <div>
        <button type="submit" className={quiet ? "btn" : "btn btn-primary"} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
