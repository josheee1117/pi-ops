import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiRuntimeConfig } from './config.js';

export interface RuntimeModelRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface RuntimeModelResponse {
  text: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Optional Pi SDK adapter. Uses only createAgentSession + noTools:'all'
 * from @earendil-works/pi-coding-agent (same APIs as apps/agent pi-sdk-client).
 * Default CI path is the deterministic coordinator and does not call this.
 */
export async function createPiRuntimeModel(config: PiRuntimeConfig): Promise<(request: RuntimeModelRequest) => Promise<RuntimeModelResponse>> {
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import('@earendil-works/pi-coding-agent');

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (config.piApiKey) {
    await modelRuntime.setRuntimeApiKey(config.piProvider, config.piApiKey);
  }
  const model = modelRuntime.getModel(config.piProvider, config.piModel);
  if (!model) throw new Error(`Unknown Pi model ${config.piProvider}/${config.piModel}`);
  const isolatedDir = await mkdtemp(join(tmpdir(), 'pi-ops-runtime-'));

  return async (request) => {
    const loader = new DefaultResourceLoader({
      cwd: isolatedDir,
      agentDir: isolatedDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => request.system,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: isolatedDir,
      agentDir: isolatedDir,
      model,
      thinkingLevel: 'off',
      modelRuntime,
      noTools: 'all',
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    const abort = () => {
      void session.abort();
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      await session.prompt(request.user);
      const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
      if (!assistant || assistant.role !== 'assistant') {
        throw new Error('Pi SDK returned no assistant message');
      }
      const text = assistant.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
      return {
        text,
        provider: String(assistant.provider ?? config.piProvider),
        model: assistant.model ?? config.piModel,
        inputTokens: assistant.usage.input,
        outputTokens: assistant.usage.output,
      };
    } finally {
      request.signal?.removeEventListener('abort', abort);
      session.dispose();
    }
  };
}
