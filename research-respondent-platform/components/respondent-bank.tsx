"use client";
import { useRef, useState, type FormEvent } from "react";
import type { CabinetAsset } from "../lib/domain/cabinet.ts";
import type { BankSpec, BankSummary } from "../lib/domain/respondent-bank.ts";
import styles from "./cabinet.module.css";

interface Preview { previewHash: string; summary: BankSummary; headers: string[]; spec: BankSpec }
type Request = (body: unknown) => Promise<{ previewHash?: string; summary?: BankSummary; headers?: string[]; asset?: CabinetAsset }>;
const suggestedId = (asset?: CabinetAsset) => asset?.headers?.find((h) => ["participant_id", "respondent_id", "id"].includes(h)) ?? "";
export function RespondentBank({ assets, request, onCreated }: {
  assets: CabinetAsset[]; request: Request; onCreated: (asset: CabinetAsset) => Promise<void>;
}) {
  const sources = assets.filter((a) => a.kind === "source");
  const [mode, setMode] = useState<"merge" | "join">("merge");
  const [leftId, setLeftId] = useState(""); const [rightId, setRightId] = useState("");
  const [leftHeader, setLeftHeader] = useState(""); const [rightHeader, setRightHeader] = useState("");
  const [extra, setExtra] = useState(""); const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const revision = useRef(0);
  const left = sources.find((a) => a.id === leftId), right = sources.find((a) => a.id === rightId);
  const leftIdHeader = leftHeader || suggestedId(left), rightIdHeader = rightHeader || suggestedId(right);
  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const current = revision.current;
    const spec: BankSpec = { mode, leftId, rightId, leftIdHeader, rightIdHeader, additionalKeyHeaders: extra ? [extra] : [],
      name: String(data.get("bankName")), reference: String(data.get("bankReference")), rights: String(data.get("bankRights")) };
    setBusy(true); setError(""); setNotice(""); setPreview(null);
    try { const result = await request({ command: "bank_preview", spec });
      if (current === revision.current && result.previewHash && result.summary && result.headers) setPreview({ previewHash: result.previewHash, summary: result.summary, headers: result.headers, spec });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось проверить объединение."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || preview.summary.conflicts) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await request({ command: "bank_commit", spec: preview.spec, previewHash: preview.previewHash });
      if (!result.asset) throw new Error("Сайт не подтвердил сохранение.");
      await onCreated(result.asset); setPreview(null); setNotice(`Версия «${result.asset.name}» сохранена. Она выбрана в форме создания проекта.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить версию."); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-labelledby="bank-heading">
    <h2 id="bank-heading">Банк респондентов</h2>
    <p>Пополняйте базу по постоянному ID или присоединяйте характеристики к ответам. Исходные файлы и старые проекты сохраняются.</p>
    <div className={styles.actions}><a className="btn" href="/bank-templates/participants.csv" download>Шаблон участников CSV</a><a className="btn" href="/bank-templates/answers.csv" download>Шаблон ответов CSV</a></div>
    <p>Одна строка — участник или прохождение. Для повторных прохождений добавьте response_id к ключу. Каждый вопрос — отдельный столбец; пустое значение означает отсутствие ответа.</p>
    {sources.length < 2 ? <p>Загрузите две базы выше: сохранённую и дополнение либо ответы и характеристики участников.</p> :
      <form onSubmit={(e) => void inspect(e)} onChange={() => { revision.current++; setPreview(null); setNotice(""); }}>
        <fieldset disabled={busy} className={styles.bankFields}>
          <label>Действие с банком<select aria-label="Действие с банком" className="input" value={mode} onChange={(e) => { setMode(e.target.value as "merge" | "join"); setExtra(""); }}><option value="merge">Пополнить базу</option><option value="join">Присоединить характеристики к ответам</option></select></label>
          <label>{mode === "merge" ? "Сохранённая база" : "База ответов для объединения"}<select aria-label={mode === "merge" ? "Сохранённая база" : "База ответов для объединения"} className="input" value={leftId} required onChange={(e) => { setLeftId(e.target.value); setLeftHeader(""); setExtra(""); }}><option value="">Выберите файл</option>{sources.map((a) => <option key={a.id} value={a.id} disabled={a.id === rightId}>{a.name} · {a.records} записей</option>)}</select></label>
          <label>{mode === "merge" ? "Дополнение к базе" : "База характеристик участников"}<select aria-label={mode === "merge" ? "Дополнение к базе" : "База характеристик участников"} className="input" value={rightId} required onChange={(e) => { setRightId(e.target.value); setRightHeader(""); setExtra(""); }}><option value="">Выберите файл</option>{sources.map((a) => <option key={a.id} value={a.id} disabled={a.id === leftId}>{a.name} · {a.records} записей</option>)}</select></label>
          <label>ID в первой базе<select aria-label="ID в первой базе" className="input" value={leftIdHeader} required onChange={(e) => setLeftHeader(e.target.value)}><option value="">Выберите столбец</option>{left?.headers?.map((h) => <option key={h}>{h}</option>)}</select></label>
          <label>ID во второй базе<select aria-label="ID во второй базе" className="input" value={rightIdHeader} required onChange={(e) => setRightHeader(e.target.value)}><option value="">Выберите столбец</option>{right?.headers?.map((h) => <option key={h}>{h}</option>)}</select></label>
          <label>Дополнительный ключ прохождения<select aria-label="Дополнительный ключ прохождения" className="input" value={extra} onChange={(e) => setExtra(e.target.value)}><option value="">Только ID участника</option>{left?.headers?.filter((h) => h !== leftIdHeader && h !== rightIdHeader && (mode === "join" || right?.headers?.includes(h))).map((h) => <option key={h}>{h}</option>)}</select></label>
          <label>Название новой версии<input className="input" name="bankName" required maxLength={200} defaultValue="Банк респондентов" /></label>
          <label>Источник и версия результата<input className="input" name="bankReference" required maxLength={500} placeholder="Методика, версия и дата объединения" /></label>
          <label>Основание использования результата<input className="input" name="bankRights" required maxLength={500} placeholder="Разрешённая цель использования этих источников" /></label>
          <button className="btn btn-primary" disabled={busy}>Проверить объединение</button>
        </fieldset>
      </form>}
    {error ? <p role="alert" className="note note-fail">{error}</p> : null}
    {notice ? <p role="status" className="note note-ok">{notice}</p> : null}
    {preview ? <div className={styles.bankReport} role="status">
      <h3>Результат проверки</h3>
      <dl><div><dt>Записей в результате</dt><dd>{preview.summary.resultRecords}</dd></div><div><dt>Новых записей</dt><dd>{preview.summary.addedRecords}</dd></div><div><dt>Совпадений по ключу</dt><dd>{preview.summary.matchedRecords}</dd></div><div><dt>Точных дублей исключено</dt><dd>{preview.summary.duplicatesRemoved}</dd></div><div><dt>Значений добавлено из второго источника</dt><dd>{preview.summary.filledCells}</dd></div><div><dt>Конфликтов</dt><dd>{preview.summary.conflicts}</dd></div></dl>
      {preview.spec.mode === "join" ? <p>Ответов без профиля: {preview.summary.unmatchedRecords}. Неиспользованных профилей: {preview.summary.unusedProfiles}. Ответы без совпадения сохраняются с пустыми характеристиками.</p> : null}
      {preview.summary.conflicts ? <><p className="note note-fail">Сохранение заблокировано. Различающиеся значения не заменяются автоматически. Для повторных прохождений уточните дополнительный ключ.</p><ul>{preview.summary.issues.map((item, i) => <li key={i}>{item.code === "invalid_key" ? "Пустой или некорректный ключ" : item.code === "duplicate_key" ? "Разные записи с одним ключом" : "Различающиеся значения"} · {item.header} · {item.source === "left" ? "первая база" : "вторая база"}, строка {item.leftLine}{item.rightLine ? `; строка ${item.rightLine}` : ""}</li>)}</ul>{preview.summary.conflicts > preview.summary.issues.length ? <p>Показаны первые {preview.summary.issues.length} проблем из {preview.summary.conflicts}.</p> : null}</> : <p>Исходные ответы сохранены. Каждый результат будет связан с файлами-источниками, их контрольными суммами и строками.</p>}
      <button className="btn btn-primary" disabled={busy || !!preview.summary.conflicts} onClick={() => void save()}>Сохранить версию банка</button>
    </div> : null}
  </section>;
}
