/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, messagesToPrompt, extractModel } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;
    let toolCallIndex = 0;
    let inToolBlock = false;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle POST /v1/responses  (OpenAI Responses API — minimal, structured-output focused)
 *
 * Clients like graphiti_core call `client.responses.parse(model, input,
 * max_output_tokens, text_format=<schema>)` and read `response.output_text`
 * (json.loads) plus `response.usage`. The Claude CLI has no Responses API, so we
 * flatten the request into a single prompt (injecting the requested JSON Schema as
 * an instruction), run the CLI, and return a Responses-shaped object whose
 * `output_text` is the cleaned JSON. Non-streaming only (what parse() uses).
 */
interface ResponsesInputItem {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}
interface OpenAIResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  text?: { format?: Record<string, unknown> };
  response_format?: Record<string, unknown>;
  stream?: boolean;
}

function buildResponsesPrompt(body: OpenAIResponsesRequest): { prompt: string; model: ReturnType<typeof extractModel> } {
  const messages: OpenAIChatRequest["messages"] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const it of body.input) {
      // Responses content blocks use {type:"input_text"|"output_text", text}; the
      // openai-to-cli extractor already understands input_text/text.
      messages.push({ role: it.role as "system" | "user" | "assistant", content: it.content as never });
    }
  }
  let prompt = messagesToPrompt(messages);

  // The OpenAI SDK serialises text_format=<pydantic> into text.format =
  // { type:"json_schema", name, strict:true, schema:{...} }.
  const fmt = (body.text?.format ?? body.response_format) as
    | { type?: string; schema?: unknown; json_schema?: { schema?: unknown } }
    | undefined;
  const schema = fmt?.schema ?? fmt?.json_schema?.schema;
  if (schema) {
    prompt +=
      "\n\n<output_format>\nRespond with ONLY a single JSON value that strictly conforms to this JSON Schema. " +
      "Output raw JSON — no prose, no explanation, no markdown code fences.\nJSON Schema:\n" +
      JSON.stringify(schema) +
      "\n</output_format>";
  } else if (fmt?.type === "json_object") {
    prompt += "\n\n<output_format>\nRespond with ONLY a valid JSON object. No prose, no markdown fences.\n</output_format>";
  }
  return { prompt, model: extractModel(body.model) };
}

/** Best-effort: pull a clean JSON string out of the model's text output. */
function extractJsonText(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  if (!(t.startsWith("{") || t.startsWith("["))) {
    const firstObj = t.indexOf("{");
    const firstArr = t.indexOf("[");
    const candidates = [firstObj, firstArr].filter((i) => i !== -1);
    const start = candidates.length ? Math.min(...candidates) : -1;
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }
  return t;
}

export async function handleResponses(req: Request, res: Response): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIResponsesRequest;

  if (!body || body.input === undefined || body.input === null) {
    res.status(400).json({
      error: { message: "input is required", type: "invalid_request_error", code: "invalid_input" },
    });
    return;
  }

  const wantsJson = !!(body.text?.format || body.response_format);
  const { prompt, model } = buildResponsesPrompt(body);
  const subprocess = new ClaudeSubprocess();

  await new Promise<void>((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (r: ClaudeCliResult) => {
      finalResult = r;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[handleResponses] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (res.headersSent) {
        resolve();
        return;
      }
      if (!finalResult) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
        resolve();
        return;
      }
      const raw = String(finalResult.result ?? "");
      const outText = wantsJson ? extractJsonText(raw) : raw;
      const usage = finalResult.usage;
      const inTok = usage?.input_tokens || 0;
      const outTok = usage?.output_tokens || 0;

      res.json({
        id: `resp_${requestId}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: body.instructions ?? null,
        max_output_tokens: body.max_output_tokens ?? null,
        model: body.model,
        output: [
          {
            type: "message",
            id: `msg_${requestId}`,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: outText, annotations: [] }],
          },
        ],
        output_text: outText,
        parallel_tool_calls: false,
        temperature: body.temperature ?? null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok },
        metadata: {},
      });
      resolve();
    });

    subprocess.start(prompt, { model }).catch((error: Error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
      }
      resolve();
    });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
