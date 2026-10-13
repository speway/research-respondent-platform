import { personaModelContract } from "../../../../lib/domain/personas.ts";
export const runtime="nodejs";
export async function GET(){return Response.json(personaModelContract(),{headers:{"Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});}
