import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LogoutButton } from "@/app/logout-button";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { DashboardNav } from "./nav";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value))) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/compose" className="text-sm font-semibold tracking-tight">
              CodeSync Hub
            </Link>
            <DashboardNav />
          </div>
          <LogoutButton />
        </div>
      </header>

      <div className="flex-1">{children}</div>
    </div>
  );
}
