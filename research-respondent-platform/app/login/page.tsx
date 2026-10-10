import { hostingMode } from "../../lib/services/hosting-policy.ts";
import { redirect } from "next/navigation";
import { LoginForm } from "../../components/login-form.tsx";
import { Panel } from "../../components/ui.tsx";
import { getCurrentAuth } from "../../lib/services/session.ts";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const preview = hostingMode(process.env) !== "persistent-local";
  const auth = await getCurrentAuth();
  if (auth) {
    redirect("/");
  }
  return (
    <div className="mx-auto grid max-w-[900px] gap-4 pt-10">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Research Respondent Platform</h1>
        <p className="mt-1 max-w-[70ch] text-[0.8125rem] text-[#55606d]">
          An operational system for documented participants and research responses: verified records, versioned
          instruments, explainable cohorts, form mappings, and audited agent tasks. Nothing in the research database is
          generated, imputed or invented.
        </p>
      </div>
      <Panel title="Sign in" subtitle="Access is role-based; identity data is a separate, explicitly granted scope.">
        <div className="p-4">
          {preview ? <p role="status" className="note">Protected infrastructure preview. Sign-in and research data entry are disabled until durable storage is configured.</p> : <LoginForm />}
        </div>
      </Panel>
      {preview ? null : <Panel title="First run" subtitle="The platform ships with an empty research database by design.">
        <div className="grid gap-2 p-4 text-[0.8125rem]">
          <p>
            Create the first administrator, organization and audit trail with:
          </p>
          <pre className="mono overflow-x-auto rounded border border-[#dfe3e8] bg-[#fbfcfd] p-2">
{`npm run db:migrate
npm run bootstrap -- --org "Your lab" --email you@example.org --password "<min 10 chars>"`}
          </pre>
          <p className="text-[#55606d]">
            No participants, instrument responses or scores are seeded. Import your own documented records through
            Participants → Import documented source.
          </p>
        </div>
      </Panel>}
    </div>
  );
}
