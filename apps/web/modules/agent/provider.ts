import "server-only";
import { env } from "@/lib/env";

/**
 * A model-agnostic seam over the chat+tools loop so the orchestrator can be
 * driven by real Gemini in production and by a scripted fake in tests (no paid
 * requests in CI). Conversation is expressed in these neutral shapes; the
 * provider maps them to its own SDK format.
 */
export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentContent =
  | { role: "user"; text: string }
  | { role: "model"; text?: string; calls?: ToolCall[] }
  | { role: "tool"; responses: Array<{ name: string; response: unknown }> };

export interface FnDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
}

export interface ModelProvider {
  readonly model: string;
  generate(req: {
    system: string;
    contents: AgentContent[];
    tools: FnDecl[];
  }): Promise<ModelTurn>;
}

/** Real Gemini, via the official @google/genai SDK (manual function calling). */
class GeminiProvider implements ModelProvider {
  readonly model: string;
  // Lazy so the SDK isn't imported when AI is disabled.
  #ai: import("@google/genai").GoogleGenAI | null = null;
  #apiKey: string;

  constructor(apiKey: string, model: string) {
    this.#apiKey = apiKey;
    this.model = model;
  }

  async #client() {
    if (!this.#ai) {
      const { GoogleGenAI } = await import("@google/genai");
      this.#ai = new GoogleGenAI({ apiKey: this.#apiKey });
    }
    return this.#ai;
  }

  async generate(req: {
    system: string;
    contents: AgentContent[];
    tools: FnDecl[];
  }): Promise<ModelTurn> {
    const ai = await this.#client();
    const contents = req.contents.map(toSdkContent);
    const resp = await ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: req.system,
        tools: [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
      },
    });
    const calls: ToolCall[] = (resp.functionCalls ?? []).map((c) => ({
      id: c.id,
      name: c.name ?? "",
      args: (c.args ?? {}) as Record<string, unknown>,
    }));
    return { text: (resp.text ?? "").slice(0, 20_000), calls };
  }
}

// AgentContent → @google/genai Content. functionResponse parts ride in a
// "user" content (Gemini only has user/model roles).
function toSdkContent(c: AgentContent): {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
} {
  if (c.role === "user") return { role: "user", parts: [{ text: c.text }] };
  if (c.role === "tool") {
    return {
      role: "user",
      parts: c.responses.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.response } },
      })),
    };
  }
  const parts: Array<Record<string, unknown>> = [];
  if (c.text) parts.push({ text: c.text });
  for (const call of c.calls ?? []) {
    parts.push({ functionCall: { name: call.name, args: call.args } });
  }
  return { role: "model", parts };
}

/**
 * The provider for the current config, or null when AI is off / unkeyed — the
 * caller then uses the deterministic parser. Kosh always works without a key.
 */
export function getProvider(): ModelProvider | null {
  const e = env();
  if (!e.KOSH_AI_ENABLED || !e.GEMINI_API_KEY) return null;
  return new GeminiProvider(e.GEMINI_API_KEY, e.GEMINI_MODEL);
}

export function aiEnabled(): boolean {
  return getProvider() !== null;
}

/** Public, secret-free AI status for settings/onboarding UI. */
export function getAiStatus(): {
  aiEnabled: boolean;
  hasKey: boolean;
  model: string;
  mcpEnabled: boolean;
} {
  const e = env();
  return {
    aiEnabled: e.KOSH_AI_ENABLED && !!e.GEMINI_API_KEY,
    hasKey: !!e.GEMINI_API_KEY,
    model: e.GEMINI_MODEL,
    mcpEnabled: e.KOSH_MCP_ENABLED,
  };
}
