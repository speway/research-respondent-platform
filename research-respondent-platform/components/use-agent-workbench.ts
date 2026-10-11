"use client";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { z } from "zod";
import { agentProblems, applyObservation, buildAgentPlan, workspaceForTarget, workspaceFromTask, type AgentTask, type FormObservation } from "../lib/domain/agent-workbench.ts";
import { emptyWorkspace, selectedRows, type Workspace } from "../lib/domain/workbench.ts";

const revision = z.number().int().nonnegative();
const commandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z.object({ command: z.literal("load"), expectedRevision: revision, task: z.unknown() }).strict(),
  z.object({ command: z.literal("target"), expectedRevision: revision, formUrl: z.string() }).strict(),
  z.object({ command: z.literal("observe"), expectedRevision: revision, observation: z.unknown() }).strict(),
  z.object({ command: z.literal("plan"), expectedRevision: revision }).strict(),
  z.object({ command: z.literal("clear"), expectedRevision: revision }).strict(),
]);
interface State { workspace: Workspace; observation: FormObservation | null; revision: number; lastCommand: string }
export interface WorkbenchAgent { protocol: "rrp.workbench-agent.v1"; execute(input: unknown): Promise<unknown> }
declare global { interface Window { respondentWorkbench?: WorkbenchAgent } }

/** Same-tab control only. This is deliberately not an anonymous server API. */
export function useAgentWorkbench(initialTask?: AgentTask) {
  const [state, setState] = useState<State>(() => ({ workspace: emptyWorkspace(), observation: null, revision: 0, lastCommand: "" }));
  const current = useRef(state);
  const pending = useRef(false);
  const [initialError, setInitialError] = useState("");
  const commit = useCallback((workspace: Workspace, observation: FormObservation | null, lastCommand = "") => {
    const next = { workspace, observation, revision: current.current.revision + 1, lastCommand };
    current.current = next;
    setState(next);
  }, []);
  const setWorkspace = useCallback((value: SetStateAction<Workspace>) => {
    const next = typeof value === "function" ? value(current.current.workspace) : value;
    commit(next, null);
  }, [commit]);
  const execute = useCallback(async (input: unknown) => {
    const command = commandSchema.parse(input);
    const snapshot = () => {
      const s = current.current;
      const problems = agentProblems(s.workspace, s.observation);
      return { protocol: "rrp.workbench-agent.v1", revision: s.revision, busy: pending.current,
        status: !s.workspace.dataset ? "awaiting_source" : !s.observation ? "awaiting_form_observation" : problems.length ? "blocked" : "ready",
        source: s.workspace.dataset ? { name: s.workspace.dataset.name, sha256: s.workspace.checksum, headers: s.workspace.dataset.headers, count: s.workspace.dataset.rows.length, selected: selectedRows(s.workspace).length } : null,
        formUrl: s.workspace.formUrl, scope: s.observation?.scope ?? null, problems: problems.slice(0, 100), lastCommand: s.lastCommand };
    };
    if (command.command === "status") return snapshot();
    if (pending.current) throw new Error("Другая команда выполняется. Прочитайте status и дождитесь busy=false.");
    if (command.expectedRevision !== current.current.revision) throw new Error("Устаревшая команда. Прочитайте текущую revision и пересчитайте действие.");
    if (command.command === "plan") return buildAgentPlan(current.current.workspace, current.current.observation);
    pending.current = true;
    try {
      const startedRevision = current.current.revision;
      if (command.command === "load") {
        const workspace = await workspaceFromTask(command.task);
        if (startedRevision !== current.current.revision) throw new Error("Панель изменена во время загрузки. Команда отменена.");
        commit(workspace, null, "load");
      } else if (command.command === "target") {
        commit(workspaceForTarget(current.current.workspace, command.formUrl), null, "target");
      } else if (command.command === "observe") {
        const next = applyObservation(current.current.workspace, command.observation);
        commit(next.workspace, next.observation, "observe");
      } else commit(emptyWorkspace(), null, "clear");
    } finally { pending.current = false; }
    return snapshot();
  }, [commit]);
  useEffect(() => {
    const bridge: WorkbenchAgent = Object.freeze({ protocol: "rrp.workbench-agent.v1", execute });
    window.respondentWorkbench = bridge;
    return () => { if (window.respondentWorkbench === bridge) delete window.respondentWorkbench; };
  }, [execute]);
  useEffect(() => {
    if (!initialTask) return;
    void execute({ command: "load", expectedRevision: current.current.revision, task: initialTask })
      .catch((error: unknown) => setInitialError(error instanceof Error ? error.message : "Проект не загружен."));
  }, [execute, initialTask]);
  return { ...state, initialError, setWorkspace, execute, problems: agentProblems(state.workspace, state.observation) };
}
