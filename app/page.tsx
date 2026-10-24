import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

const EXPECTED_TABLES = ["social_accounts", "posts", "post_media", "post_targets"];

type DbStatus =
  | { state: "ok"; present: string[]; missing: string[] }
  | { state: "error"; message: string }
  | { state: "unconfigured" };

async function getDbStatus(): Promise<DbStatus> {
  if (!process.env.DATABASE_URL) return { state: "unconfigured" };

  try {
    const rows = await getPrisma().$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const present = rows.map((row) => row.table_name);
    const missing = EXPECTED_TABLES.filter((table) => !present.includes(table));
    return { state: "ok", present, missing };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "Unknown error";
    return { state: "error", message };
  }
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
}) {
  const tone =
    ok === null
      ? "bg-amber-500"
      : ok
        ? "bg-emerald-500"
        : "bg-red-500";

  return (
    <div className="flex items-start gap-3 py-3">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tone}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 break-words text-sm text-zinc-600 dark:text-zinc-400">{detail}</p>
      </div>
    </div>
  );
}

export default async function HomePage() {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value))) {
    redirect("/login");
  }

  const db = await getDbStatus();

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">CodeSync Hub</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Phase 1 — foundation. Signed in as the owner.
          </p>
        </div>
        <LogoutButton />
      </header>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white px-5 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
        <StatusRow label="Login" ok detail="Authenticated with the single-user password." />

        {db.state === "unconfigured" ? (
          <StatusRow label="Database" ok={null} detail="DATABASE_URL is not set in .env.local." />
        ) : db.state === "error" ? (
          <StatusRow label="Database" ok={false} detail={db.message} />
        ) : db.missing.length > 0 ? (
          <StatusRow
            label="Database"
            ok={false}
            detail={`Connected, but missing tables: ${db.missing.join(", ")}. Run "npm run db:migrate".`}
          />
        ) : (
          <StatusRow
            label="Database"
            ok
            detail={`Connected — all 4 tables migrated (${db.present.join(", ")}).`}
          />
        )}
      </section>

      <p className="mt-6 text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
        Only Phase 1 is built: project setup, schema and login. Compose, preview, publishers,
        scheduler and AI generation are not implemented yet.
      </p>
    </main>
  );
}
