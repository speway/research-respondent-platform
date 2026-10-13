import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { validatePersonaJob, type PersonaJob } from "../domain/personas.ts";
import { PERSONA_BANK_LIMITS as limits } from "../domain/persona-bank.ts";
import { sha256 } from "./password.ts";
interface PersonaSandbox {
  writeFiles(files: {path:string;content:Buffer}[]): Promise<unknown>;
  runCommand(options: {cmd:string;args:string[];cwd:string;env:Record<string,string>}): Promise<{exitCode:number|null}>;
  readFileToBuffer(file:{path:string}):Promise<Buffer|null>;
  stop():Promise<unknown>;
}
export type PersonaSandboxFactory = (options:{image:string;timeout:number;resources:{vcpus:number};persistent:false;networkPolicy:"deny-all";ports:[]})=>Promise<PersonaSandbox>;
export async function runCloudPersonaJob(job: PersonaJob, allowed: ()=>Promise<void>, factory:PersonaSandboxFactory = options=>Sandbox.create(options)) {
  validatePersonaJob(job);
  if (Buffer.byteLength(JSON.stringify(job)) > limits.bytes) throw new Error("Persona input exceeds application limit.");
  const root = join(process.cwd(),"tools/psychological-personas");
  const manifest = JSON.parse(await readFile(join(root,"manifest.json"),"utf8")) as {sha256:Record<string,string>};
  const files = await Promise.all(Object.entries(manifest.sha256).map(async ([path,hash])=>{
    if (!/^(scripts|references|assets)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error("Invalid pinned worker path.");
    const content = await readFile(join(root,path)); if (sha256(content.toString("utf8"))!==hash) throw new Error("Pinned persona worker differs from manifest.");
    return {path:`/vercel/sandbox/model/${path}`,content};
  }));
  await allowed();
  const sandbox = await factory({image:"vercel/sandbox/python:3.14",timeout:limits.sandboxMs,resources:{vcpus:1},persistent:false,networkPolicy:"deny-all",ports:[]});
  try {
    await allowed();
    await sandbox.writeFiles([...files,{path:"/vercel/sandbox/input.json",content:Buffer.from(JSON.stringify(job))},{path:"/vercel/sandbox/entry.py",content:Buffer.from(`import sys, resource
resource.setrlimit(resource.RLIMIT_CPU, (45,45))
resource.setrlimit(resource.RLIMIT_AS, (536870912,536870912))
resource.setrlimit(resource.RLIMIT_FSIZE, (3145728,3145728))
sys.path.insert(0, '/vercel/sandbox/model/scripts')
import worker
with open('/vercel/sandbox/input.json', encoding='utf-8') as source, open('/vercel/sandbox/output.json', 'w', encoding='utf-8') as target:
    sys.stdin, sys.stdout = source, target
    status = worker.main()
sys.exit(status)
`)}]);
    await allowed();
    const command = await sandbox.runCommand({cmd:"python3",args:["/vercel/sandbox/entry.py"],cwd:"/vercel/sandbox",env:{PYTHONDONTWRITEBYTECODE:"1",PYTHONHASHSEED:"0"}});
    if(command.exitCode!==0) throw new Error("Persona worker failed; no automatic retry.");
    await allowed();
    const result = await sandbox.readFileToBuffer({path:"/vercel/sandbox/output.json"});
    if(!result || result.length>3*1024*1024) throw new Error("Missing/oversized persona worker output.");
    return JSON.parse(result.toString("utf8")) as unknown;
  } finally {await sandbox.stop();}
}
