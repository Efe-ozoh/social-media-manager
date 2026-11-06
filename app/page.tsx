import { redirect } from "next/navigation";

/** The dashboard now opens on Compose. Login is enforced by proxy.ts. */
export default function HomePage() {
  redirect("/compose");
}
