import { getSettings } from '../settings.ts';
import { streamChat } from '../llm/index.ts';
import type { LlmMessage, ToolCall } from '../llm/types.ts';
import type { ApprovalRow } from '../approvals.ts';
import { logActivity } from '../activity.ts';
import { truncate } from '../util.ts';
import { getTool, toolSchemas, type ToolContext, type ToolResult } from './tools.ts';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'approval'; approval: ApprovalRow }
  | { type: 'usage'; promptTokens: number; completionTokens: number };

export interface AgentLoopOptions {
  messages: LlmMessage[];
  context: ToolContext;
  maxSteps?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
  kind?: string;
  /** Restrict the toolset, e.g. for read-only runs. */
  allowTools?: string[];
}

export interface AgentLoopResult {
  text: string;
  toolCalls: number;
  approval: ApprovalRow | null;
  error: string | null;
  aborted: boolean;
  promptTokens: number;
  completionTokens: number;
}

function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `Could not parse tool arguments: ${(error as Error).message}` };
  }
}

/** Drain a generator while observing its events (used by task execution). */
export async function drainAgent<T>(
  generator: AsyncGenerator<AgentEvent, T>,
  onEvent?: (event: AgentEvent) => void,
): Promise<T> {
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
    onEvent?.(next.value);
  }
}

export async function* agentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, AgentLoopResult> {
  const settings = getSettings();
  const maxSteps = Math.max(1, options.maxSteps ?? 8);
  const maxToolCalls = Math.max(1, options.maxToolCalls ?? 25);
  const messages = [...options.messages];
  const result: AgentLoopResult = {
    text: '',
    toolCalls: 0,
    approval: null,
    error: null,
    aborted: false,
    promptTokens: 0,
    completionTokens: 0,
  };

  let finalText = '';
  const tools = toolSchemas(options.allowTools);

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }

    let stepText = '';
    const calls: ToolCall[] = [];

    try {
      for await (const event of streamChat({
        messages,
        tools,
        model: settings.model.model,
        temperature: settings.model.temperature,
        maxTokens: settings.model.maxTokens,
        signal: options.signal,
        kind: options.kind ?? 'chat',
        taskId: options.context.taskId ?? null,
      })) {
        if (event.type === 'text') {
          stepText += event.delta;
          yield { type: 'text', delta: event.delta };
        } else if (event.type === 'tool') {
          calls.push(event.call);
        } else if (event.type === 'usage') {
          result.promptTokens += event.promptTokens;
          result.completionTokens += event.completionTokens;
          yield { type: 'usage', promptTokens: event.promptTokens, completionTokens: event.completionTokens };
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        result.aborted = true;
        break;
      }
      result.error = `${(error as Error).message}`;
      break;
    }

    finalText = stepText;

    if (!calls.length) break;

    messages.push({ role: 'assistant', content: stepText, toolCalls: calls });

    for (const call of calls) {
      result.toolCalls += 1;
      if (result.toolCalls > maxToolCalls) {
        result.error = `Stopped after ${maxToolCalls} tool calls in one run to prevent runaway work.`;
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: 'Tool budget exhausted for this run.',
        });
        break;
      }

      const tool = getTool(call.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `There is no tool named "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.`,
        });
        continue;
      }

      const parsed = parseArgs(call.arguments);
      if (!parsed.ok) {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: parsed.error });
        continue;
      }

      // Emergency stop: no side-effecting tools at all.
      if (settings.autonomy.state === 'stopped' && tool.risk !== 'low') {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: 'Blocked: the owner activated the emergency stop. No side-effecting tools may run. Explain this instead of retrying.',
        });
        continue;
      }

      // Autonomous-first: the tool runs now. There is no approval step.
      yield { type: 'tool_start', name: tool.name };

      let toolResult: ToolResult;
      try {
        toolResult = await tool.run(parsed.value, options.context);
      } catch (error) {
        toolResult = {
          ok: false,
          content: `The tool failed: ${(error as Error).message}`,
          summary: `${tool.name} failed.`,
        };
      }

      const content = truncate(toolResult.content, 14_000);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: tool.name,
        content,
        untrusted: toolResult.untrusted,
      });

      logActivity({
        level: toolResult.ok ? 'info' : 'warn',
        category: 'tool',
        message: `${tool.name}: ${toolResult.summary}`,
        meta: { tool: tool.name, ok: toolResult.ok },
        taskId: options.context.taskId ?? null,
        conversationId: options.context.conversationId ?? null,
      });

      yield { type: 'tool_end', name: tool.name, ok: toolResult.ok, summary: toolResult.summary };
    }

    if (result.error) break;
  }

  result.text = finalText;
  if (!result.text && result.approval) {
    result.text = "I've paused for your approval before doing that.";
  }
  return result;
}

/** Execute a tool directly, bypassing the approval gate (only after the owner approved). */
export async function executeApprovedTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = getTool(toolName);
  if (!tool) return { ok: false, content: `Unknown tool ${toolName}.`, summary: 'Approval target missing.' };
  try {
    return await tool.run(args, context);
  } catch (error) {
    return { ok: false, content: `The tool failed: ${(error as Error).message}`, summary: `${toolName} failed.` };
  }
}
