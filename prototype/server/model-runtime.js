import { createModels, createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export class ModelConfigError extends Error {
  constructor(message, code = 'MODEL_CONFIG') {
    super(message);
    this.name = 'ModelConfigError';
    this.code = code;
    this.status = 400;
  }
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ModelConfigError('模型接口地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelConfigError('模型接口地址须为不含凭证、查询参数或片段的 HTTP 地址。');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ModelConfigError('远程模型接口须使用 HTTPS。');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Create an app-owned runtime. No ambient environment or Pi/Codex files are read. */
export function createRuntime(config, { credentials } = {}) {
  if (!config || !['openai', 'anthropic', 'openai-compatible'].includes(config.provider)) {
    throw new ModelConfigError('请选择受支持的模型服务。');
  }
  const auth = config.auth ?? 'api';
  if (!['api', 'oauth'].includes(auth)) throw new ModelConfigError('模型认证方式无效。');
  if (auth === 'oauth' && config.provider === 'openai-compatible') {
    throw new ModelConfigError('兼容接口当前仅支持 API Key。');
  }
  if (auth === 'oauth' && config.baseUrl) throw new ModelConfigError('OAuth 连接须使用服务商官方接口。');
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (apiKey.length > 8192) throw new ModelConfigError('模型凭证格式无效。');
  const modelId = typeof config.model === 'string' ? config.model.trim() : '';
  if (modelId.length > 200 || /[\r\n\0]/.test(modelId)) throw new ModelConfigError('模型名称无效。');

  // API sessions deliberately ignore a stored OAuth credential for the same provider.
  const models = createModels({
    credentials: auth === 'oauth' ? (credentials ?? new InMemoryCredentialStore()) : new InMemoryCredentialStore(),
    authContext: {
      env: async (name) => auth === 'api' && ((config.provider === 'openai' && name === 'OPENAI_API_KEY')
        || (config.provider === 'anthropic' && name === 'ANTHROPIC_API_KEY')) ? apiKey || undefined : undefined,
      fileExists: async () => false,
    },
  });

  const providerId = config.provider;
  let provider;
  let baseUrl;
  if (providerId === 'openai-compatible') {
    if (!config.baseUrl) throw new ModelConfigError('请填写兼容接口地址。');
    baseUrl = endpoint(config.baseUrl);
    provider = createProvider({
      id: providerId,
      name: 'OpenAI compatible',
      baseUrl,
      auth: { apiKey: { name: 'API key', resolve: async () => apiKey ? { auth: { apiKey } } : undefined } },
      models: modelId ? [{
        id: modelId, name: modelId, api: 'openai-completions', provider: providerId, baseUrl,
        reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
      }] : [],
      api: openAICompletionsApi(),
    });
  } else {
    // Pi 1.3.0 owns Sign in with ChatGPT on `openai`, using the Responses API.
    // `openai-codex` is a separate legacy flow, endpoint and credential identity.
    // Keep catalog, login and requests on the same provider; catalogs do not prove account access.
    provider = providerId === 'openai' ? openaiProvider() : anthropicProvider();
    if (config.baseUrl) baseUrl = endpoint(config.baseUrl);
  }
  models.setProvider(provider);
  const catalogModel = modelId ? models.getModel(providerId, modelId) : undefined;
  if (modelId && !catalogModel) throw new ModelConfigError('该服务商目录中没有这个模型，请重新选择。', 'MODEL_NOT_FOUND');
  const model = catalogModel && baseUrl ? { ...catalogModel, baseUrl } : catalogModel;
  return { models, model, providerId };
}
