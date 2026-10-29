// Test-only omp extension, never deployed: omp/tests/smoke.sh loads it with `omp -e` so the smoke runs offline.
//
// It registers the provider `fakellm` (model `fake-1`) whose replies come from a script instead of an LLM, and
// appends what omp showed it to a JSON-lines dump so the smoke can assert on the real harness:
//   ECOMONO_OMP_SCRIPT      JSON array of steps. {tool, args} emits a tool call, {text} is the final answer;
//                           past the end the reply is the text "done".
//   ECOMONO_OMP_DUMP        file that receives one JSON line per event:
//     {ev: "prompt"}        at before_agent_start: the joined system prompt, command names and tool names,
//                           i.e. what persona, style, skills, commands and the memory bundle resolved to;
//     {ev: "request"}       on every provider request: the last context message, which after a tool call is
//                           the tool result as the model sees it (the compression handler's output);
//     {ev: "spawn"}         at before_subagent_spawn: agent, invocationKind, modelRole and patterns.
//   ECOMONO_OMP_BLOCK_SPAWN=1 makes the spawn handler refuse, so a scripted `task` call stops at preflight.
//
// The step index is the number of tool-result messages already in the request context, not a counter in this
// module: a subagent session starts with a fresh context and would otherwise replay or skip steps.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock"
import { appendFileSync, readFileSync } from "node:fs"

type Step = { tool: string; args?: Record<string, unknown> } | { text: string }

function dump(entry: Record<string, unknown>): void {
  const file = process.env.ECOMONO_OMP_DUMP
  if (file) appendFileSync(file, JSON.stringify(entry) + "\n")
}

function loadScript(): Step[] {
  const file = process.env.ECOMONO_OMP_SCRIPT
  if (!file) return []
  const steps = JSON.parse(readFileSync(file, "utf8"))
  return Array.isArray(steps) ? steps : []
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("fakellm", {
    baseUrl: "https://fake.invalid/",
    apiKey: "unused",
    api: "fake-api",
    streamSimple: (model, context, options) => {
      const messages = context.messages as Array<{ role: string }>
      const index = messages.filter(m => m.role === "toolResult").length
      dump({ ev: "request", last: messages[messages.length - 1] })
      const step = loadScript()[index]
      const handler = () => {
        if (step && "tool" in step) {
          return { content: [{ type: "toolCall" as const, name: step.tool, arguments: step.args ?? {} }] }
        }
        return { content: [step && "text" in step ? step.text : "done"] }
      }
      return streamMock(createMockModel({ id: model.id, provider: model.provider, handler }), context, options)
    },
    models: [
      {
        id: "fake-1",
        name: "Fake 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 8000,
      },
    ],
  })

  pi.on("before_agent_start", async event => {
    const prompt = event.systemPrompt as unknown
    dump({
      ev: "prompt",
      systemPrompt: Array.isArray(prompt) ? prompt.join("\n") : String(prompt),
      commands: pi.getCommands().map(c => c.name),
      tools: pi.getAllTools().map(t => t.name),
    })
    return undefined
  })

  pi.on("before_subagent_spawn", async event => {
    dump({
      ev: "spawn",
      agent: event.agent,
      invocationKind: event.invocationKind,
      modelRole: event.modelRole ?? null,
      patterns: event.patterns,
    })
    if (process.env.ECOMONO_OMP_BLOCK_SPAWN === "1") return { block: true, reason: "smoke: spawn stopped" }
    return undefined
  })
}
