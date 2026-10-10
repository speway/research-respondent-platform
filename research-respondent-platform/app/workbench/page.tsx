import { redirect } from "next/navigation";
import { Workbench } from "../../components/workbench.tsx";
import { hostingMode } from "../../lib/services/hosting-policy.ts";

export const metadata = { title: "Панель подготовки · Respondent Lab" };
export const dynamic = "force-dynamic";
export default function WorkbenchPage() {
  if (hostingMode(process.env) === "blocked-production") redirect("/login");
  return <Workbench />;
}
