import type { AuthUser, ModelOption } from '../api/client';

const STORAGE_PREFIX = 'chatgpt-proxy:model-preference:v1';

export function modelOptionKey(option: ModelOption): string {
  return `${option.model}|${option.thinking_effort || ''}`;
}

export function modelPreferenceKey(user: AuthUser | null): string | null {
  if (!user) return null;
  const identity = user.id?.trim() || user.email.trim().toLowerCase();
  return identity ? `${STORAGE_PREFIX}:${identity}` : null;
}

export function resolvePreferredModel(
  options: ModelOption[],
  defaultModel: string,
  savedOptionKey: string | null,
  defaultThinkingEffort?: string,
): ModelOption | undefined {
  if (!options.length) return undefined;

  return options.find((option) => modelOptionKey(option) === savedOptionKey)
    || options.find((option) => option.model === defaultModel && option.thinking_effort === defaultThinkingEffort)
    || options.find((option) => option.model === defaultModel && option.thinking_effort === 'standard')
    || options.find((option) => option.model === defaultModel)
    || options.find((option) => option.thinking_effort === 'standard')
    || options[0];
}
