import { AccountsList } from "./accounts-list";

export default function AccountsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        LinkedIn posts through OAuth; Telegram uses a bot token from the server
        environment. Tokens never reach this page.
      </p>

      <AccountsList />
    </main>
  );
}
