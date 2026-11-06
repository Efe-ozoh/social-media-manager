import Link from "next/link";

export default function AccountsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Connect, reconnect and disconnect controls arrive in the next Phase 5
        step. Compose already reflects each account&apos;s safe connection status.
      </p>
      <Link
        href="/compose"
        className="mt-6 inline-flex rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Back to Compose
      </Link>
    </main>
  );
}
