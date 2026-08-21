import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';
import type { PiClient, PiClientResponse } from './pi-client.js';

/**
 * Production Pi SDK adapter. Tools are disabled; the session cannot run shell,
 * edit files, or call extensions discovered from the operator's Pi agent dir.
 */
export async function createPiSdkClient(config: AgentConfig): Promise<PiClient> {
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
  if (!model) {
    throw new Error(`Unknown Pi model ${config.piProvider}/${config.piModel}`);
  }

  const isolatedDir = await mkdtemp(join(tmpdir(), 'pi-ops-reasoner-'));

  return {
    async invoke(request): Promise<PiClientResponse> {
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
        if (request.signal?.aborted) throw new Error('reasoning timeout');
        await session.prompt(request.user);
        const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
        if (!assistant || assistant.role !== 'assistant') {
          throw new Error('Pi SDK returned no assistant message');
        }
        if (assistant.stopReason === 'error' || assistant.errorMessage) {
          throw new Error(assistant.errorMessage ?? 'Pi SDK assistant error');
        }
        const text = assistant.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join('');
        return {
          text,
          provider: String(assistant.provider ?? config.piProvider),
          model: assistant.model ?? config.piModel,
          usage: {
            inputTokens: assistant.usage.input,
            outputTokens: assistant.usage.output,
          },
        };
      } finally {
        request.signal?.removeEventListener('abort', abort);
        session.dispose();
      }
    },
  };
}
