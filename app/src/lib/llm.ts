/**
 * The seller's actual work: a real LLM completion through the official SDK.
 *
 * The SDK defaults are the sane ones - `https://api.openai.com/v1` and a
 * current model - and the environment only *overrides* them. Pointing
 * `OPENAI_BASE_URL` at any OpenAI-compatible gateway is the supported way to
 * swap providers, not the primary configuration path.
 */
import OpenAI from "openai";

import { openaiConfig } from "./config";

export type Completion = {
  /** The text the buyer is paying for. */
  summary: string;
  model: string;
  /** Raw body exactly as the seller will send it, so the hash is honest. */
  body: string;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export class LlmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LlmError";
  }
}

const SYSTEM_PROMPT =
  "You summarize text for a paying client. Reply with a single dense " +
  "paragraph of 60 to 180 words. No preamble, no bullet points, no headings.";

let clientSingleton: OpenAI | undefined;
let clientKey: string | undefined;

/**
 * One client per process.
 *
 * Rebuilt only when the effective config changes, which in practice means never
 * at runtime but keeps a test that swaps the base URL from leaking a stale
 * client into the next call.
 */
function client(): OpenAI {
  const { apiKey, baseURL } = openaiConfig();

  if (!apiKey) {
    throw new LlmError(
      "OPENAI_API_KEY is not set; the seller cannot call a model",
      500
    );
  }

  const key = `${baseURL}|${apiKey}`;
  if (!clientSingleton || clientKey !== key) {
    clientSingleton = new OpenAI({ apiKey, baseURL });
    clientKey = key;
  }

  return clientSingleton;
}

/**
 * Ask the configured model to summarize `input`.
 *
 * The returned body is serialized here, once, and that exact string is what the
 * arbiter hashes. Serializing twice would let whitespace drift break the hash
 * check on a perfectly honest response.
 */
export async function summarize(input: string): Promise<Completion> {
  const { model } = openaiConfig();

  let response;
  try {
    response = await client().chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.2,
    });
  } catch (err) {
    // The SDK already normalizes provider failures into typed errors, so the
    // status travels through instead of being flattened into a 500.
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : 502;
    throw new LlmError((err as Error).message, status);
  }

  const summary = response.choices[0]?.message?.content?.trim() ?? "";

  const completion: Completion = {
    summary,
    model: response.model || model,
    body: "",
    usage: {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    },
  };

  completion.body = JSON.stringify({
    summary: completion.summary,
    model: completion.model,
    inputLength: input.length,
  });

  return completion;
}
