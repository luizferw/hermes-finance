import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import { answerAsk } from "@/modules/ask/orchestrate";

const askSchema = z.object({ query: z.string().min(1).max(200) });

export const POST = withUser(async (req) => {
  const { query } = await parseBody(req, askSchema);
  return ok(await answerAsk(query));
});
