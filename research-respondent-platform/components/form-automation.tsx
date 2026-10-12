"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CabinetProject } from "../lib/domain/cabinet.ts";
import type { AutomationRequest, AutomationView } from "../lib/domain/form-automation.ts";
import styles from "./cabinet.module.css";
interface Candidate { project: CabinetProject; sourceChecks: { readyForFormObservation: boolean; selectedRecords: number; blockers: string[] };
  participants: string[]; evidenceFiles: Array<{ id: string; name: string }> }
const labels: Record<AutomationView["status"], string> = {
  reserved: "Подготовлен", queued: "В очереди", running: "Выполняется в облаке", cancellation_requested: "Остановка запрошена",
  cancelled: "Остановлен", failed: "Остановлен из-за ошибки", execution_uncertain: "Результат неизвестен; повтор запрещён",
  prepared: "Первый раздел проверен", blocked: "Нужны данные или совместимые элементы",
  filled_not_submitted: "Разделы заполнены без отправки", response_recorded: "Ответ записан", submission_uncertain: "Отправка не подтверждена; повтор запрещён",
};
const active = (job: AutomationView) => ["queued", "running", "cancellation_requested"].includes(job.status);
async function request(path = "/api/cabinet/automation", body?: unknown) {
  const r = await fetch(path, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error ?? "Запуск не подтверждён."); return value;
}
export function FormAutomationPanel({ projects }: { projects: CabinetProject[] }) {
  const [flags, setFlags] = useState({ enabled: false, writes: false });
  const [jobs, setJobs] = useState<AutomationView[]>([]); const [projectId, setProjectId] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null); const [mode, setMode] = useState<AutomationRequest["mode"]>("prepare");
  const [participant, setParticipant] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const requestId = useRef<string | null>(null), revision = useRef(0);
  const activeJobIds = jobs.filter(active).map((j) => j.id).join(",");
  useEffect(() => {
    let current = true;
    void request().then((r) => { if (current) { setJobs(r.jobs); setFlags(r.flags); } }).catch(() => { if (current) setError("Не удалось прочитать журнал запусков."); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!activeJobIds) return;
    let current = true;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void Promise.all(activeJobIds.split(",").map((id) => request(`/api/cabinet/automation?job=${id}`))).then((updated: AutomationView[]) => {
        if (current) setJobs((old) => old.map((job) => updated.find((next) => next.id === job.id) ?? job));
      }).catch(() => { if (current) setError("Статус пока недоступен. Не запускайте повторно."); });
    }, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [activeJobIds]);
  async function chooseProject(id: string) {
    const version = ++revision.current; setProjectId(id); setParticipant(""); setCandidate(null); requestId.current = null; setError("");
    if (!id) return; setBusy(true);
    try { const r = await request(`/api/cabinet/automation?project=${id}`); if (revision.current === version) setCandidate(r); }
    catch (e) { if (revision.current === version) setError(e instanceof Error ? e.message : "Проект недоступен."); }
    finally { if (revision.current === version) setBusy(false); }
  }
  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const input: AutomationRequest = { requestId: requestId.current, projectId, participantRef: participant, mode,
        consentConfirmed: data.get("consent") === "on", recipientConfirmed: data.get("recipient") === "on",
        ...(mode !== "prepare" ? { evidenceAssetId: String(data.get("evidence")), evidenceReference: String(data.get("reference")) } : {}) };
      const job: AutomationView = await request("/api/cabinet/automation", { command: "start", request: input });
      setJobs((old) => [job, ...old.filter((j) => j.id !== job.id)]);
      setLastJobId(job.id);
      // Keep the request ID after an uncertain response. Only a terminal success permits a fresh run.
    } catch (e) { setError(e instanceof Error ? e.message : "Регистрация не подтверждена. Сверьте журнал перед повтором."); }
    finally { setBusy(false); }
  }
  async function stop(id: string) {
    setBusy(true); setError("");
    try { const job: AutomationView = await request("/api/cabinet/automation", { command: "cancel", jobId: id }); setJobs((old) => old.map((j) => j.id === id ? job : j)); }
    catch (e) { setError(e instanceof Error ? e.message : "Остановка не подтверждена."); }
    finally { setBusy(false); }
  }
  const lastJob = jobs.find((job) => job.id === lastJobId);
  const mayRunAgain = lastJob && ["prepared", "blocked", "filled_not_submitted", "failed", "cancelled"].includes(lastJob.status);
  return <section className={styles.panel} aria-labelledby="automation-heading">
    <h2 id="automation-heading">Автоматическое заполнение</h2>
    <p>Выберите сохранённый проект один раз. Исполнитель читает форму, переносит ответы и проверяет каждый раздел. Вкладку можно закрыть: результат сохранится здесь.</p>
    {!flags.enabled ? <p>Облачный исполнитель пока не подключён к этому окружению. Базы и инструкции внешнему агенту доступны выше.</p> : null}
    {!projects.length ? <p>Сначала создайте проект со ссылкой Google Forms и сохранённой базой.</p> : <form onSubmit={(e) => void launch(e)}>
      <fieldset disabled={busy} className={styles.bankFields}>
        <label>Проект для автоматизации<select className="input" aria-label="Проект для автоматизации" required value={projectId} onChange={(e) => void chooseProject(e.target.value)}><option value="">Выберите проект</option>{projects.map((p) => <option value={p.id} key={p.id}>{p.name} · {new Date(p.createdAt).toLocaleString("ru-RU")}</option>)}</select></label>
        <label>Участник для запуска<select className="input" aria-label="Участник для запуска" required value={participant} onChange={(e) => { setParticipant(e.target.value); requestId.current = null; }}><option value="">Выберите ID</option>{candidate?.participants.map((id, i) => <option key={`${id}-${i}`} value={id}>{id}</option>)}</select></label>
        <label>Режим исполнителя<select className="input" aria-label="Режим исполнителя" value={mode} onChange={(e) => { setMode(e.target.value as AutomationRequest["mode"]); requestId.current = null; }}><option value="prepare">Проверить без ввода</option><option value="fill" disabled={!flags.writes}>Заполнить без отправки</option><option value="submit" disabled={!flags.writes}>Заполнить и отправить один ответ</option></select></label>
        {candidate ? <p>Отобрано записей: {candidate.sourceChecks.selectedRecords}. {candidate.sourceChecks.readyForFormObservation ? "ID прошли проверку." : "Уточните отбор: пустые или повторные ID."}<br />Получатель: {candidate.project.formUrl}</p> : null}
        {mode !== "prepare" ? <><label>Документ основания / согласия<select className="input" name="evidence" aria-label="Документ основания / согласия" required><option value="">Выберите загруженный документ</option>{candidate?.evidenceFiles.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Основание и разрешённая цель<input className="input" name="reference" required maxLength={1000} /></label><label className={styles.check}><input type="checkbox" name="consent" required />Подтверждаю разрешение участника на передачу этих ответов и проверенный документ основания.</label><label className={styles.check}><input type="checkbox" name="recipient" required />Разрешаю ввод выбранного участника именно в указанную форму{mode === "submit" ? " и одну отправку" : " без отправки"}.</label></> : null}
        <button className="btn btn-primary" disabled={!flags.enabled || busy || !candidate?.sourceChecks.readyForFormObservation || !participant}>Запустить исполнителя</button>
      </fieldset>
    </form>}
    <p>Пилот: один участник за запуск, до пяти минут и трёх запусков в день. Проверка без ввода охватывает первый доступный раздел; следующие разделы проверяются при заполнении по фактическим ответам.</p>
    {error ? <p role="alert" className="note note-fail">{error}</p> : null}
    {mayRunAgain ? <button className="btn" disabled={busy} onClick={() => { requestId.current = null; setLastJobId(null); setError(""); }}>Подготовить новый запуск после завершения</button> : null}
    <h3>Журнал запусков</h3>
    {jobs.length ? <div className={styles.items}>{jobs.map((job) => <article key={job.id}><div><strong>{job.projectName} · {job.participantRef}</strong><p>{labels[job.status]} · {new Date(job.createdAt).toLocaleString("ru-RU")}</p>{job.progress && !job.result ? <p>Раздел {job.progress.sectionNumber}; проверено полей: {job.progress.questionsVerified}.</p> : null}{job.result ? <><p>Проверено разделов: {job.result.sectionsVerified}; полей: {job.result.questionsVerified}.</p>{job.result.problems.map((p, i) => <p key={i}>{p}</p>)}</> : null}</div>{active(job) ? <button className="btn" disabled={busy} onClick={() => void stop(job.id)}>Остановить запуск</button> : null}</article>)}</div> : <p>Запусков пока нет. Неопределённый результат не считается отправкой и не повторяется автоматически.</p>}
  </section>;
}
