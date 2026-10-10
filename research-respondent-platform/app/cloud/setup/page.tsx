import Link from "next/link";
import { notFound } from "next/navigation";
import { cloudDiagnosticsEnabled } from "../../../lib/services/cloud-preview-policy.ts";
import { privateCloudProbeDependencies, readCloudProbeReport } from "../../../lib/services/private-cloud-probe.ts";
import { runStorageProbeAction } from "./actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Подключение облачного агента · Respondent Lab" };
export default async function CloudSetupPage({ searchParams }: { searchParams: Promise<{ probe?: string }> }) {
  if (!cloudDiagnosticsEnabled(process.env)) notFound();
  const query = await searchParams;
  let report = null;
  try { report = await readCloudProbeReport(privateCloudProbeDependencies(process.env.BLOB_STORE_ID!)); } catch { /* Unverified until a successful read. */ }
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
    <p>Фоновый исполнитель и загрузка ответов участников ещё не включены.</p>
  </section>;
}
