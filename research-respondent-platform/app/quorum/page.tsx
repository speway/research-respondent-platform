import { QuorumParticipantView } from "../../components/quorum-participant.tsx";
import { cabinetReady } from "../../lib/services/cabinet.ts";
export const metadata = { referrer: "no-referrer" as const, title: "Кворум · Обмен опросами и проверка агента", description: "Участие в исследованиях, прозрачные кредиты и слепое сравнение человека с персональным агентом." };
export const dynamic = "force-dynamic";
export default function QuorumPage() { return <QuorumParticipantView configured={cabinetReady()} />; }
