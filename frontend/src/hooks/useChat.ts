import { chat, type FileAsset, type ImageGroup, type Source, type StreamPayload, type UploadedFile } from '../api/client';
import { sanitizeCitations } from '../utils/format';

export interface StreamMessageParams {
  message: string;
  model: string;
  conversationId?: string;
  genId?: string;
  attachments?: UploadedFile[];
  thinkingEffort?: string;
  retryAssistantMessageId?: string;
  imageMode?: boolean;
  imageReference?: UploadedFile;
  onConversationCreated?: (id: string) => void;
  onToken?: (token: string) => void;
  onImages?: (images: FileAsset[]) => void;
  onStatus?: (status: string) => void;
  onReasoning?: (reasoning: string) => void;
  onSources?: (sources: Source[]) => void;
  onImageGroups?: (groups: ImageGroup[]) => void;
  onMessageId?: (id: string) => void;
  onDone?: (fullMessage: string) => void;
  onError?: (error: Error) => void;
}

function userFacingStreamError(message: string): string {
  if (/Timed out waiting for|SSE.*(?:超时|中断|错误|终止)|No response body/i.test(message)) {
    return '响应连接中断，结果可能仍在处理中。请稍后重新打开此对话查看，或点击重试。';
  }
  if (/Browser fetch failed|Resume HTTP|Cloudflare challenge/i.test(message)) {
    return '与 ChatGPT 的连接暂时中断，请完成浏览器验证后重试。';
  }
  return message;
}

function dispatchPayload(parsed: StreamPayload, params: StreamMessageParams, content: string): string {
  let fullContent = content;
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.conversation_id && !params.conversationId) params.onConversationCreated?.(parsed.conversation_id);
  if (parsed.content) {
    fullContent += parsed.content;
    params.onToken?.(sanitizeCitations(fullContent));
  }
  if (parsed.images?.length) params.onImages?.(parsed.images);
  if (parsed.status) params.onStatus?.(parsed.status);
  if (parsed.reasoning) params.onReasoning?.(parsed.reasoning);
  if (parsed.sources?.length) params.onSources?.(parsed.sources);
  if (parsed.image_groups?.length) params.onImageGroups?.(parsed.image_groups);
  if (parsed.message_id) params.onMessageId?.(parsed.message_id);
  return fullContent;
}

/** Run one independent upstream stream. Lifecycle and cancellation are owned by the caller. */
export async function streamMessage(params: StreamMessageParams, signal: AbortSignal): Promise<void> {
  try {
    const response = params.retryAssistantMessageId && params.conversationId
      ? await chat.retryMessage(params.conversationId, params.retryAssistantMessageId, params.model, params.thinkingEffort, signal)
      : params.imageMode
        ? await chat.generateImage(params.message, params.model, signal, params.imageReference, params.conversationId, params.attachments || [])
        : await chat.sendMessage(
          params.message,
          params.model,
          params.conversationId,
          true,
          params.genId,
          params.attachments || [],
          params.thinkingEffort,
          signal,
        );

    if (signal.aborted) return;
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('token');
        window.location.href = '/login';
        return;
      }
      const text = await response.text().catch(() => '');
      throw new Error(text || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let eventType = 'message';

    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          eventType = 'message';
          continue;
        }
        if (trimmed.startsWith('event:')) {
          eventType = trimmed.slice(6).trim() || 'message';
          continue;
        }
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (eventType === 'error') throw new Error(data || '流式响应失败');
        if (data === '[DONE]') continue;
        try {
          fullContent = dispatchPayload(JSON.parse(data) as StreamPayload, params, fullContent);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }

    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining.startsWith('data: ')) {
      const data = remaining.slice(6).trim();
      if (data !== '[DONE]') {
        try {
          fullContent = dispatchPayload(JSON.parse(data) as StreamPayload, params, fullContent);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
    params.onDone?.(fullContent);
  } catch (error) {
    if ((error as Error).name === 'AbortError' || signal.aborted) return;
    const streamError = error instanceof Error ? error : new Error(String(error));
    console.error('[chat stream]', streamError);
    params.onError?.(new Error(userFacingStreamError(streamError.message)));
  }
}
