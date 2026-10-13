"use client";

import { useMemo, useRef, useState } from "react";
import { buildPacket, emptyWorkspace, MAX_FILE_BYTES, parseSource, preparationProblems, restoreWorkspace, selectedRows, type FieldMapping, type Rule, type Workspace } from "../lib/domain/workbench.ts";
import dictionary from "../tools/psychological-personas/references/dimensions.json";
import styles from "./workbench.module.css";
import { useAgentWorkbench } from "./use-agent-workbench.ts";
import { buildAgentPlan, type AgentTask } from "../lib/domain/agent-workbench.ts";

const sections = ["База ответов", "Отбор и классификация", "Карта формы", "Пакет для агента", "Психологический справочник", "Автоматизация"];
const groupNames: Record<string, string> = { bfi2_facets: "Большая пятёрка · BFI-2", ipip_neo_facets: "IPIP-NEO", hexaco_facets: "HEXACO", cattell_concepts: "Кеттелл · 16PF", pts_concepts: "Стреляу · PTS", rtt_concepts: "Стреляу · RTT", atq_concepts: "Темперамент · ATQ", tci_concepts: "TCI", self_regulation: "Саморегуляция", emotion_regulation: "Эмоциональная регуляция", impulsivity: "Импульсивность", resources: "Ресурсы", attachment: "Привязанность", coping_tendencies: "Совладание", mpq_concepts: "MPQ", value_priorities: "Ценностные приоритеты", reporting_style: "Стиль самоотчёта" };
const operators: Array<[Rule["op"], string]> = [["eq", "Равно"], ["ne", "Не равно"], ["contains", "Содержит"], ["gte", "Не меньше"], ["lte", "Не больше"], ["present", "Заполнено"], ["missing", "Отсутствует"]];

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function message(error: unknown) { return error instanceof Error ? error.message : "Не удалось обработать файл."; }

export function Workbench({ initialTask, projectId }: { initialTask?: AgentTask; projectId?: string }) {
  const agent = useAgentWorkbench(initialTask);
  const { workspace, setWorkspace } = agent;
  const [section, setSection] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [targetLink, setTargetLink] = useState("");
  const [draft, setDraft] = useState<Rule>({ column: 0, op: "gte", value: "", label: "" });
  const importSequence = useRef(0);
  const sourceInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const agentInput = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => selectedRows(workspace), [workspace]);
  const problems = useMemo(() => preparationProblems(workspace), [workspace]);
  const dataset = workspace.dataset;
  const headers = dataset?.headers ?? [];
  const shownPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const shownRows = rows.slice(shownPage * 20, (shownPage + 1) * 20);
  const update = (patch: Partial<Workspace>) => setWorkspace((current) => ({ ...current, ...patch }));

  async function load(file: File | undefined, project = false) {
    if (!file) return;
    const sequence = ++importSequence.current;
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > (project ? MAX_FILE_BYTES * 3 : MAX_FILE_BYTES)) throw new Error("Файл слишком большой. База: до 5 МБ; проект: до 15 МБ.");
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let next: Workspace;
      if (project) next = restoreWorkspace(text);
      else {
        const parsed = parseSource(file.name, text);
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const checksum = [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
        next = { ...emptyWorkspace(), dataset: parsed, checksum, reference: file.name };
      }
      if (sequence !== importSequence.current) return;
      setWorkspace(next); setPage(0); setSection(0); setDraft({ column: 0, op: "gte", value: "", label: "" });
      setNotice(project ? "Проект восстановлен из файла." : `Загружено записей: ${next.dataset?.rows.length ?? 0}. Значения сохранены без изменений.`);
    } catch (cause) { if (sequence === importSequence.current) setError(message(cause)); }
    finally { if (sequence === importSequence.current) setBusy(false); if (sourceInput.current) sourceInput.current.value = ""; if (projectInput.current) projectInput.current.value = ""; }
  }
  function addRule() {
    if (!headers.length) return;
    if (!["present", "missing"].includes(draft.op) && !draft.value.trim()) { setError("Укажите значение критерия."); return; }
    update({ rules: [...workspace.rules, { ...draft, label: draft.label.trim() || headers[draft.column]! }] });
    setPage(0); setError(""); setNotice("Критерий добавлен. Исходные ответы не изменены.");
  }
  function editField(index: number, patch: Partial<FieldMapping>) { update({ fields: workspace.fields.map((field, i) => i === index ? { ...field, ...patch } : field) }); }
  function exportPacket() { try { download("form-agent-packet.json", buildPacket(workspace)); setNotice("Пакет скачан. Ответы во внешнюю форму не отправлялись."); setError(""); } catch (cause) { setError(message(cause)); } }
  const selectedCount = rows.length;
  async function loadAgentTask(file: File | undefined) {
    if (!file) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      if (file.size > MAX_FILE_BYTES * 3) throw new Error("Задание превышает 15 МБ.");
      const task: unknown = JSON.parse(await file.text());
      await agent.execute({ command: "load", expectedRevision: agent.revision, task });
      setNotice("Задание загружено. Агент может прочитать форму и сопоставить ответы через программный вход.");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); if (agentInput.current) agentInput.current.value = ""; }
  }
  async function saveToCabinet() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cabinet/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "snapshot", projectId,
        settings: { checksum: workspace.checksum, formUrl: workspace.formUrl, purpose: workspace.purpose,
          ...(workspace.sourceRows ? { sourceRows: workspace.sourceRows } : {}),
          idHeader: workspace.idColumn !== null ? workspace.dataset?.headers[workspace.idColumn] : "", match: workspace.match,
          criteria: workspace.rules.map((rule) => ({ header: workspace.dataset?.headers[rule.column], op: rule.op, value: rule.value, label: rule.label })) } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Проект не сохранён.");
      setNotice("Новая версия проекта сохранена в кабинете. Создайте ключ этой версии для агента.");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  return <div className={styles.shell} lang="ru">
    <aside className={styles.sidebar}>
      <a className={styles.brand} href="/workbench"><span>Ψ</span><div>Respondent Lab<small>ПАНЕЛЬ ПОДГОТОВКИ</small></div></a>
      <p className={styles.sideLabel}>РАБОЧИЙ ПРОЦЕСС</p>
      <nav aria-label="Меню подготовки">{sections.map((label, index) => <button key={label} type="button" className={section === index ? styles.active : ""} aria-current={section === index ? "page" : undefined} onClick={() => { setSection(index); setError(""); }}><span>{String(index + 1).padStart(2, "0")}</span>{label}</button>)}</nav>
      <div className={styles.sideNote}><span className={styles.dot} /> {projectId ? "Проект из кабинета" : "На вашем устройстве"}<p>{projectId ? "Настройки можно сохранить новой версией. Новые базы и опросники загружайте через кабинет." : "Файл обрабатывается в браузере. Для хранения на сайте загрузите его через кабинет."}</p><a href="/cabinet">Личный кабинет ↗</a><a href="/quorum">Кворум · Участникам ↗</a></div>
    </aside>
    <div className={styles.main}>
      <div className={styles.topbar}><span>Исследование / Подготовка · <a href="/cabinet">Кабинет</a></span><div>{projectId ? <button className="btn btn-primary" disabled={!dataset || busy} onClick={() => void saveToCabinet()}>Сохранить в кабинете</button> : null}<button className="btn" disabled={!dataset || busy} onClick={() => { download("respondent-project.json", workspace); setNotice("Проект скачан вместе с базой и настройками. Для продолжения загрузите этот файл."); }}>Сохранить проект</button><button className="btn" disabled={busy} onClick={() => projectInput.current?.click()}>Открыть проект</button></div></div>
      <input className={styles.hidden} type="file" accept=".json" ref={projectInput} aria-label="Файл сохранённого проекта" onChange={(event) => void load(event.target.files?.[0], true)} />
      <header className={styles.heading}><div><p>ОТ ИСХОДНИКА К ГОТОВОЙ КАРТЕ</p><h1>{sections[section]}</h1><div>База → критерии → вопросы → задание агенту</div></div><span className={styles.badge}>Первичная рабочая версия</span></header>
      <div className={styles.metrics}><div><span>Записи в базе</span><strong>{dataset?.rows.length ?? "—"}</strong><small>{dataset?.name ?? "Загрузите исходный файл"}</small></div><div><span>После отбора</span><strong>{dataset ? selectedCount : "—"}</strong><small>{workspace.rules.length} критериев</small></div><div><span>Вопросы формы</span><strong>{workspace.fields.length || "—"}</strong><small>{workspace.fields.filter((f) => f.column !== null).length} сопоставлено</small></div><div><span>Состояние подготовки</span><strong className={styles.status}>{problems.length ? "В работе" : "Готово"}</strong><small>{problems.length ? "Проверьте пакет для агента" : "Можно скачать пакет"}</small></div></div>
      {error || agent.initialError ? <p className="note note-fail" role="alert">{error || agent.initialError}</p> : null}
      {notice ? <p className="note note-ok" role="status">{notice}</p> : null}
      {busy ? <p className="note" role="status">Читаю файл и проверяю структуру…</p> : null}

      {section === 0 ? <>
        <section className={styles.panel}><div className={styles.panelTitle}><h2>Начните с базы ответов</h2><span>CSV · TSV · JSON</span></div><div className={styles.upload}><div className={styles.uploadIcon}>↑</div><h3>{dataset ? "Заменить исходный файл" : "Загрузите свой файл"}</h3><p>Одна запись на участника, заголовки в первой строке.<br />Excel сохраните как CSV UTF-8. До 5 МБ.</p><button className="btn btn-primary" disabled={busy} onClick={() => sourceInput.current?.click()}>Выбрать файл</button><input ref={sourceInput} type="file" className={styles.hidden} accept=".csv,.tsv,.json,.txt" aria-label="Исходная база ответов" onChange={(event) => void load(event.target.files?.[0])} /><small>Повторная загрузка заменит базу и сбросит её настройки.</small></div>
          <details className={styles.formatHelp}><summary>Как подготовить файл</summary><p>Например, заголовки: participant_id, возраст, группа, ответ_1. Для JSON используйте массив объектов с такими ключами. Добавляйте только фактические значения; пропуски оставляйте пустыми. Повторяющиеся вопросы различите названием раздела.</p></details></section>
        {dataset ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Источник и идентификаторы</h2><span>{headers.length} столбцов</span></div><div className={styles.formGrid}><label>Описание источника<input className="input" value={workspace.reference} onChange={(e) => update({ reference: e.target.value })} placeholder="Файл, дата сбора, версия" /></label><label>ID участника<select className="input" aria-label="ID участника" value={workspace.idColumn ?? ""} onChange={(e) => update({ idColumn: e.target.value === "" ? null : Number(e.target.value) })}><option value="">Выберите столбец</option>{headers.map((h, i) => <option key={h} value={i}>{h}</option>)}</select></label></div><p className={styles.hash}>SHA-256 исходного файла: {workspace.checksum}</p></section> : null}
      </> : null}

      {section === 1 ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Критерии и группы</h2><span>Исходные значения сохраняются</span></div><div className={styles.content}><p>Отбирайте по любому столбцу. Название критерия станет отдельной меткой в пакете; ответы участника остаются исходными.</p><label className={styles.blockLabel}>Как объединять критерии<select className="input" aria-label="Как объединять критерии" value={workspace.match} onChange={(e) => update({ match: e.target.value as Workspace["match"] })}><option value="all">Все критерии одновременно</option><option value="any">Хотя бы один критерий</option></select></label><div className={styles.ruleBuilder}><label>Столбец<select className="input" aria-label="Столбец критерия" value={draft.column} disabled={!dataset} onChange={(e) => setDraft({ ...draft, column: Number(e.target.value) })}>{headers.map((h, i) => <option key={h} value={i}>{h}</option>)}</select></label><label>Условие<select className="input" aria-label="Условие" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as Rule["op"] })}>{operators.map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select></label><label>Значение<input className="input" value={draft.value} disabled={["present", "missing"].includes(draft.op)} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder="Например: 18" /></label><label>Название группы<input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Например: 18 лет и старше" /></label></div><button className="btn btn-primary" disabled={!dataset} onClick={addRule}>Добавить критерий</button><div className={styles.rules}>{workspace.rules.map((r, i) => <div key={i}><div><strong>{r.label}</strong><small>{headers[r.column]} · {operators.find(([op]) => op === r.op)?.[1]} {r.value}</small></div><button className="btn" aria-label={`Удалить критерий ${r.label}`} onClick={() => update({ rules: workspace.rules.filter((_, j) => j !== i) })}>Удалить</button></div>)}</div>{!dataset ? <p className="note">Сначала загрузите базу в первом разделе.</p> : null}</div></section> : null}

      {section === 2 ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Сопоставление вопросов</h2><span>Буквальные ответы из источника</span></div><div className={styles.content}><label className={styles.blockLabel}>Ссылка Google Forms<input className="input" type="url" value={workspace.formUrl} onChange={(e) => update({ formUrl: e.target.value })} placeholder="https://docs.google.com/forms/…" /></label><p>Скопируйте точный текст вопроса и выберите его столбец. В первой версии вопросы добавляются вручную; ссылка не загружает структуру формы автоматически.</p><div className={styles.actions}><button className="btn btn-primary" disabled={!dataset} onClick={() => update({ fields: [...workspace.fields, { question: "", column: null, required: true }] })}>Добавить вопрос</button><button className="btn" disabled={!dataset || workspace.fields.length > 0} onClick={() => update({ fields: headers.map((question, column) => ({ question, column, required: true })) })}>Взять вопросы из заголовков</button></div><div className={styles.mappings}>{workspace.fields.map((field, i) => <div key={i}><label>Вопрос {i + 1}<input className="input" aria-label={`Текст вопроса ${i + 1}`} value={field.question} onChange={(e) => editField(i, { question: e.target.value })} /></label><label>Ответ из столбца<select className="input" aria-label={`Столбец ответа ${i + 1}`} value={field.column ?? ""} onChange={(e) => editField(i, { column: e.target.value === "" ? null : Number(e.target.value) })}><option value="">Не сопоставлен</option>{headers.map((h, j) => <option value={j} key={h}>{h}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={field.required} onChange={(e) => editField(i, { required: e.target.checked })} />Обязательный</label><button className="btn" aria-label={`Удалить вопрос ${i + 1}`} onClick={() => update({ fields: workspace.fields.filter((_, j) => j !== i) })}>Удалить</button></div>)}</div></div></section> : null}

      {section === 3 ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Задание для любого агента</h2><span>JSON · открытый формат</span></div><div className={styles.content}><label className={styles.blockLabel}>Задача исследования<textarea className="input" rows={3} value={workspace.purpose} onChange={(e) => update({ purpose: e.target.value })} placeholder="Что нужно перенести, в какую форму и для какой задачи" /></label><p>Пакет содержит отобранные записи, карту вопросов, исходные ответы и ссылки на их ячейки. Его можно передать ChatGPT или другому агенту с поддержкой JSON.</p><div className={styles.checks}><h3>{problems.length ? "Перед подготовкой" : "Проверка пройдена"}</h3>{problems.length ? <ul>{problems.slice(0, 15).map((problem, i) => <li key={i}>{problem}</li>)}{problems.length > 15 ? <li>Ещё замечаний: {problems.length - 15}</li> : null}</ul> : <p>У выбранных записей есть ID и все обязательные ответы. Пакет готов к проверке агентом.</p>}</div><button className="btn btn-primary" disabled={problems.length > 0} onClick={exportPacket}>Скачать пакет для агента</button><p className={styles.footnote}>Скачивание подготавливает задание. Этот сайт пока не отправляет ответы в Google Forms. Перед передачей агенту проверьте разрешение на выбранного получателя и соответствие вариантов ответов форме.</p></div></section> : null}

      {section === 4 ? <section className={styles.panel}><div className={styles.panelTitle}><h2>17 групп · 169 характеристик</h2><a href="https://github.com/speway/research-respondent-platform/pull/6" target="_blank" rel="noreferrer">Источник навыка ↗</a></div><div className={styles.content}><p>Справочник из generate-psychological-personas помогает назвать критерии и найти нужный конструкт. Для отбора используйте измеренные столбцы своей базы. Название конструкта само по себе не является результатом методики.</p><label className={styles.blockLabel}>Поиск характеристики<input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Тревожность, общительность, саморегуляция…" /></label><div className={styles.library}>{Object.entries(dictionary.groups).map(([group, definition]) => {
        const dimensions = Object.entries(definition.dimensions).filter(([key, d]) => `${key} ${d.label_ru} ${groupNames[group]}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")));
        return dimensions.length ? <div key={group}><h3>{groupNames[group] ?? group}</h3><div>{dimensions.map(([key, d]) => <button key={key} title="Использовать как название критерия" onClick={() => { setDraft({ ...draft, label: d.label_ru }); setSection(1); setNotice(`Название критерия: ${d.label_ru}. Выберите измеренный столбец и условие.`); }}>{d.label_ru}</button>)}</div></div> : null;
      })}</div></div></section> : null}

      {section === 5 ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Рабочее место агента</h2><span>Открытый протокол · v1</span></div><div className={styles.content}>
        <p>Передайте агенту ссылку на эту панель, исходную базу и задачу. Через программный вход он загрузит данные, прочитает видимые вопросы формы, автоматически найдёт однозначные соответствия и проверит план заполнения.</p>
        <p>Браузерный исполнитель поддерживает текст, числа, одиночный и множественный выбор, списки и матрицы с подписанными строками. Для каждого нового раздела он заново читает вопросы и проверяет введённые значения. Неоднозначные столбцы и отсутствующие ответы останавливают проход.</p>
        <div className={styles.actions}><label>Новая ссылка Google Forms<input type="url" value={targetLink} onChange={(event) => setTargetLink(event.target.value)} placeholder="https://docs.google.com/forms/…" /></label><button className="btn btn-primary" disabled={!dataset || busy} onClick={() => { void agent.execute({ command: "target", expectedRevision: agent.revision, formUrl: targetLink }).then(() => { setNotice("Ссылка принята. База и критерии сохранены; агент должен прочитать новую форму."); setError(""); }).catch((cause) => setError(message(cause))); }}>Использовать эту базу</button></div><p>Базу и критерии достаточно передать один раз в этой вкладке. Для следующей формы агент получает только новую ссылку и заново проверяет её вопросы. После закрытия вкладки откройте сохранённый проект.</p><div className={styles.actions}><a className="btn" href="/.well-known/rrp-agent.json" target="_blank" rel="noreferrer">Инструкция для агента</a><button className="btn" disabled={busy} onClick={() => agentInput.current?.click()}>Открыть задание агента</button><input type="file" accept=".json" ref={agentInput} className={styles.hidden} aria-label="Задание агента" onChange={(e) => void loadAgentTask(e.target.files?.[0])} /></div>
        <div className={styles.checks}><h3>{agent.observation ? agent.problems.length ? "Проход остановлен" : "План готов" : "Программный вход готов"}</h3><p>Версия панели: {agent.revision}. Последняя команда: {agent.lastCommand || "ещё не поступала"}.</p>{agent.observation ? <><p>Прочитана форма: {agent.observation.title}. {agent.observation.scope === "visible_section" ? "Проверен текущий видимый раздел." : "Передана полная карта формы."}</p>{agent.problems.length ? <ul>{agent.problems.slice(0, 15).map((p, i) => <li key={i}>{p}</li>)}</ul> : <p>Карта и варианты проверены. Можно передать план браузерному исполнителю.</p>}</> : <p>Ожидается чтение формы агентом. Ссылка сама по себе не запускает облачного исполнителя.</p>}</div>
        <button className="btn btn-primary" disabled={agent.problems.length > 0} onClick={() => { try { download("browser-agent-plan.json", buildAgentPlan(workspace, agent.observation)); setNotice("План скачан. Отправка во внешнюю форму ещё не выполнялась."); } catch (cause) { setError(message(cause)); } }}>Скачать проверенный план</button>
        <p className={styles.footnote}>Исполнитель работает в браузере агента. Отправка доступна только для явно разрешённого получателя и участников; подтверждение результата читается в форме. В Preview нет постоянно работающего облачного агента.</p>
      </div></section> : null}

      {dataset && [0, 1].includes(section) ? <section className={styles.panel}><div className={styles.panelTitle}><h2>Предпросмотр записей</h2><span>{rows.length} после отбора · первые 8 столбцов</span></div><div className={styles.tableScroll}><table className="data-table"><thead><tr><th>Строка источника</th>{headers.slice(0, 8).map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{shownRows.map((row) => <tr key={row.line}><td>{row.line}</td>{row.values.slice(0, 8).map((value, i) => <td key={i}>{value === null ? <span className={styles.missing}>нет ответа</span> : String(value)}</td>)}</tr>)}</tbody></table></div>{!rows.length ? <p className={styles.content}>Нет записей, соответствующих критериям.</p> : null}<div className={styles.pagination}><button className="btn" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Назад</button><span>{shownPage + 1} / {Math.max(1, Math.ceil(rows.length / 20))}</span><button className="btn" disabled={(shownPage + 1) * 20 >= rows.length} onClick={() => setPage(shownPage + 1)}>Далее</button></div></section> : null}
      <footer className={styles.footer}><span>{projectId ? "Исходник хранится в кабинете. Сохраните изменённые критерии новой версией." : "Данные этой панели остаются в текущей вкладке. Для хранения на сайте используйте кабинет."}</span><button disabled={busy} onClick={() => { ++importSequence.current; setWorkspace(emptyWorkspace()); setPage(0); setNotice("База и настройки удалены из текущей вкладки."); setError(""); }}>Очистить рабочую панель</button></footer>
    </div>
  </div>;
}
