import { cookies } from "next/headers";
import { CabinetError } from "./cabinet.ts";
import { configuredQuorum, QUORUM_COOKIE } from "./quorum.ts";
export async function requireQuorumPerson() {
  const quorum = configuredQuorum(), person = await quorum.session((await cookies()).get(QUORUM_COOKIE)?.value);
  if (!person) throw new CabinetError(401, "Войдите в кабинет участника.");
  return { quorum, person };
}
