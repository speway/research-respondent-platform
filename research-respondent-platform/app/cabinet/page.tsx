import { CabinetView } from "../../components/cabinet.tsx";
import { cabinetReady } from "../../lib/services/cabinet.ts";
export const metadata = { title: "Личный кабинет · Respondent Lab" };
export const dynamic = "force-dynamic";
export default function CabinetPage() { return <CabinetView configured={cabinetReady()} />; }
