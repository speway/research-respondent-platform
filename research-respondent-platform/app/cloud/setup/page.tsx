import Link from "next/link";
import { notFound } from "next/navigation";
import { cloudDiagnosticsEnabled } from "../../../lib/services/cloud-preview-policy.ts";
import { privateCloudProbeDependencies, readCloudProbeReport } from "../../../lib/services/private-cloud-probe.ts";
import { runStorageProbeAction } from "./actions.ts";
import { getRun } from "workflow/api";
import type { cloudFormAuditWorkflow } from "../../../workflows/cloud-form-audit.ts";
import { hostedAuditInput, hostedAuditDependencies, readHostedAudit } from "../../../lib/services/hosted-cloud-audit.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Подключение облачного агента · Respondent Lab" };
export default async function CloudSetupPage({ searchParams }: { searchParams: Promise<{ probe?: string; audit?: string }> }) {
  if (!cloudDiagnosticsEnabled(process.env)) notFound();
  const query = await searchParams;
  let report = null;
  try { report = await readCloudProbeReport(privateCloudProbeDependencies(process.env.BLOB_STORE_ID!)); } catch { /* Unverified until a successful read. */ }
  const input = hostedAuditInput(process.env);
  let status = "not_started";
  let result: Awaited<ReturnType<typeof cloudFormAuditWorkflow>> | null = null;
  if (input && report) {
    try {
      const record = await readHostedAudit(input, hostedAuditDependencies(process.env.BLOB_STORE_ID!, async () => { throw new Error("Read only."); }));
      if (record) {
        const run = getRun<Awaited<ReturnType<typeof cloudFormAuditWorkflow>>>(record.runId);
        status = await run.status;
        if (status === "completed") result = await run.returnValue;
      }
    } catch { status = "unavailable"; }
  }
  return <section className="mx-auto max-w-2xl space-y-5 py-8">
    <Link href="/workbench">Открыть основную панель</Link>
    <h1 className="text-2xl font-semibold">Подключение облачного агента</h1>
    <p>Приватное хранилище подключено к тестовой среде. Проверка создаёт только служебные записи и сохраняет результат в облаке.</p>
    {report ? <div role="status" className="rounded border border-green-300 bg-green-50 p-4">
      <h2 className="font-semibold">Хранилище проверено</h2>
      <p>8 одновременных попыток: 1 запись создана, 7 отклонены. Повторная запись запрещена.</p>
      <p>Чтение приложением работает. Доступ без авторизации закрыт. Результат сохранён и прочитан повторно.</p>
      <p>Проверено: <time dateTime={report.verifiedAt}>{report.verifiedAt}</time></p>
    </div> : <>
      {query.probe === "failed" ? <p role="alert">Проверка не завершена. Облачный запуск остаётся выключенным; повторное выполнение требует проверки служебной записи.</p> : null}
      <form action={runStorageProbeAction}><button className="btn" type="submit">Проверить облачное хранилище</button></form>
    </>}
    {report && input ? <div className="space-y-3 rounded border p-4">
      <h2 className="text-xl font-semibold">Фоновое чтение Google Forms</h2>
      <p>Один облачный запуск до 5 минут. Продолжает работать после закрытия вкладки. Читает первый доступный раздел; ответы не вводит и форму не отправляет.</p>
      <p>Разрешение действует до <time dateTime={input.approval.expiresAt}>{input.approval.expiresAt}</time>.</p>
      <p role="status">Статус: {status}</p>
      {result ? <p>Прочитан раздел {result.sectionNumber}; вопросов: {result.observation.questions.length}. <Link href="/cloud/audit">Открыть результат</Link></p> : null}
      {query.audit === "failed" ? <p role="alert">Запуск не подтверждён. Повтор автоматически запрещён; требуется проверка служебной записи.</p> : null}
      {status === "not_started" && query.audit !== "failed" ? <form action="/cloud/audit" method="post"><button className="btn" type="submit">Запустить чтение формы в облаке</button></form> : null}
      <Link href="/cloud/setup">Обновить статус</Link>
    </div> : <p>Фоновое чтение ещё не настроено.</p>}
    <p>Загрузка и отправка ответов участников ещё не включены.</p>
  </section>;
}
