import { parseModelJson, type RuntimeModel, type RuntimeModelRequest, type RuntimeModelResponse } from './model.js';

export const SHORT_OUTPUT_RETRY = '\n上次输出不完整或不符合结构。请重新返回更短的完整 JSON。只保留最重要事实、一个候选原因及最多3个动作，每字段一句要点。不要重复正文和结构化内容，不要输出额外字段。';

export class IncompleteModelOutputError extends Error {
  constructor(readonly responses: RuntimeModelResponse[], readonly inputTokens: number, readonly outputTokens: number, readonly validationError: string) {
    super(`诊断不完整：模型两次输出未通过 JSON 或结构校验。${validationError}`);
  }
}

export async function structuredOutput<T>(model: RuntimeModel, request: RuntimeModelRequest, decode: (value: unknown) => T) {
  const responses: RuntimeModelResponse[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let validationError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model.invoke({ ...request, system: request.system + (attempt ? SHORT_OUTPUT_RETRY : '') });
    responses.push(response);
    inputTokens += response.inputTokens ?? 0;
    outputTokens += response.outputTokens ?? 0;
    try {
      if (response.stopReason === 'length') throw new Error('model output truncated');
      return { value: decode(parseModelJson(response.text)), inputTokens, outputTokens };
    } catch (error) {
      if (request.signal?.aborted) throw error;
      validationError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new IncompleteModelOutputError(responses, inputTokens, outputTokens, validationError);
}

export function incompleteLegacy(error: IncompleteModelOutputError, fallback: { hypothesis: string; recommendation: string }) {
  const latest = [...error.responses].reverse();
  const field = (name: string, limit: number) => {
    for (const response of latest) {
      const match = response.text.match(new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
      if (!match) continue;
      try {
        const value: unknown = JSON.parse(match[1]!);
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, limit);
      } catch { continue; }
    }
    return undefined;
  };
  return {
    hypothesis: `诊断不完整。${field('hypothesis', 1800) ?? fallback.hypothesis.slice(0, 1800)}`,
    recommendation: `诊断不完整，以下仅供人工核对，修复尚未确定。${field('recommendation', 1800) ?? fallback.recommendation.slice(0, 1800)}`,
  };
}
