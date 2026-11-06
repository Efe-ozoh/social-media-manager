import { isUuid } from "@/lib/post-view";
import { ComposeForm } from "./compose-form";

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const postId = rawId && isUuid(rawId) ? rawId : null;

  return <ComposeForm postId={postId} />;
}
