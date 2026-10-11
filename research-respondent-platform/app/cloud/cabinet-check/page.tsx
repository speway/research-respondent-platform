import { notFound } from "next/navigation";
import { cabinetProofEnabled, cabinetProofReport } from "../../../lib/services/cabinet-proof.ts";
export const dynamic = "force-dynamic";
export default async function CabinetCheckPage() {
  if (!cabinetProofEnabled()) notFound();
  const report = await cabinetProofReport();
  return <section className="panel" lang="ru"><h1 className="text-2xl font-semibold">Проверка хранилища кабинета</h1>
    <p>Один запуск на закрытом Preview. Тестовые файлы изолированы от личного и общего кабинетов. Внешняя отправка отключена.</p>
    {report ? <><p role="status">Результат: {report.status} · {report.checkedAt}</p><ul>{report.checks.map((check) => <li key={check}>{check}</li>)}</ul></> :
      <form method="post" action="/cloud/cabinet-check/run"><button className="btn btn-primary">Проверить сохранение и доступ агента один раз</button></form>}
    <p><a href="/cabinet">Открыть кабинет</a></p></section>;
}
