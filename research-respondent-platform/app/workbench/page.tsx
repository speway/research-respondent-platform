import { Workbench } from "../../components/workbench.tsx";
import Link from "next/link";
import { cloudDiagnosticsEnabled } from "../../lib/services/cloud-preview-policy.ts";
import { requireCabinetAccount } from "../../lib/services/cabinet-http.ts";
import { CabinetError } from "../../lib/services/cabinet.ts";
import { redirect } from "next/navigation";

export const metadata = { title: "Панель подготовки · Respondent Lab" };
export const dynamic = "force-dynamic";
export default async function WorkbenchPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  let task;
  if (project) {
    try { const { cabinet, account } = await requireCabinetAccount(); task = (await cabinet.bundle(account, project)).task; }
    catch (error) { if (error instanceof CabinetError && [401, 503].includes(error.status)) redirect("/cabinet"); throw error; }
  }
  return <>
    {cloudDiagnosticsEnabled(process.env) ? <p className="px-2 py-2"><Link href="/cloud/setup">Подключение облачного агента</Link></p> : null}
    <Workbench initialTask={task} projectId={project} />
  </>;
}
