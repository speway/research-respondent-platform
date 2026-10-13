import { z } from "zod";
import { start } from "workflow/api";
import { personaJobWorkflow } from "../../../../workflows/persona-job.ts";
import { personaCommandSchema, PERSONA_BANK_LIMITS } from "../../../../lib/domain/persona-bank.ts";
import { configuredPersonaBank, personaWorkerEnabled } from "../../../../lib/services/persona-bank.ts";
import { CabinetError } from "../../../../lib/services/cabinet.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, privateHeaders, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(request:Request) {
  try {
    const bank=configuredPersonaBank(), auth=request.headers.get("authorization");
    if(auth!==null) {if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new CabinetError(401,"Нужен отдельный ключ персон.");return cabinetResponse(await bank.forAgent(auth.slice(7)));}
    const {account}=await requireCabinetAccount(),params=new URL(request.url).searchParams;
    if(params.has("cohort")) {const envelope=await bank.envelope(account,z.string().uuid().parse(params.get("cohort")));return new Response(JSON.stringify(envelope),{headers:{...privateHeaders,"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="personas-${envelope.asset.id}.json"`}});}
    if(params.has("job")) return cabinetResponse(await bank.view(account.id,z.string().uuid().parse(params.get("job"))));
    return cabinetResponse({assets:await bank.catalog(account),jobs:await bank.jobs(account),grants:await bank.grants(account),workerEnabled:personaWorkerEnabled(),limits:PERSONA_BANK_LIMITS});
  } catch(error){return cabinetFailure(error);}
}
export async function POST(request:Request) {
  try {
    requireCabinetOrigin(request);const {account}=await requireCabinetAccount(),bank=configuredPersonaBank(),input=personaCommandSchema.parse(await cabinetJson(request));
    if(input.command==="import") return cabinetResponse(await bank.import(account,input.requestId,input.name,input.cohort),201);
    if(input.command==="cancel") return cabinetResponse(await bank.cancel(account,input.jobId));
    if(input.command==="agent_key") return cabinetResponse(await bank.key(account,input.cohortId),201);
    if(input.command==="revoke_key") {await bank.revoke(account,input.keyId);return cabinetResponse({revoked:true});}
    if(!personaWorkerEnabled()) throw new CabinetError(503,"Python worker подготовлен, но ещё не активирован в этом окружении. Импорт готовых персон доступен.");
    const job=await bank.reserve(account,{requestId:input.requestId,name:input.name,operation:input.command,parameters:input.parameters,...(input.command==="adapt"?{cohortId:input.cohortId}:{})});
    return cabinetResponse(await bank.dispatch(job,async(accountId,jobId)=>(await start(personaJobWorkflow,[accountId,jobId])).runId),202);
  } catch(error){return cabinetFailure(error);}
}
