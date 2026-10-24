import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { LoginForm } from "./login-form";

/** Only allow same-origin path redirects after login. */
function safeNext(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const next = safeNext(params.next);

  if (await verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    redirect(next);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">CodeSync Hub</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Single-user instance. Enter the password to continue.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
