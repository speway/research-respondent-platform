import { Workbench } from "../../components/workbench.tsx";
import Link from "next/link";
import { cloudDiagnosticsEnabled } from "../../lib/services/cloud-preview-policy.ts";

export const metadata = { title: "Панель подготовки · Respondent Lab" };
export const dynamic = "force-dynamic";
export default function WorkbenchPage() {
  return <>
    {cloudDiagnosticsEnabled(process.env) ? <p className="px-2 py-2"><Link href="/cloud/setup">Подключение облачного агента</Link></p> : null}
    <Workbench />
  </>;
}
