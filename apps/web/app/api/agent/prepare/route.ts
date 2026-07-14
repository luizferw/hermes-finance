import { withUser, fail } from "@/modules/shared/api";

/** AI writes stay disabled until proposals have a durable approval record. */
export const POST = withUser(async () =>
  fail(409, "read_only", "Kosh AI is currently read-only."),
);
