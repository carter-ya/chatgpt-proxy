import { useState, useCallback, useRef } from 'react';
import { chat } from '../api/client';

interface SendMessageParams {
  message: string;
  model: string;
  conversationId?: string;
  genId?: string;
  attachmentFileId?: string;
  onConversationCreated?: (id: string) => void;
  onToken?: (token: string) => void;
  onDone?: (fullMessage: string) => void;
  onError?: (error: Error) => void;
}

interface UseChatReturn {
  sending: boolean;
  sendMessage: (params: SendMessageParams) => Promise<void>;
  cancelStream: () => void;
}

export function useChat(): UseChatReturn {
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }, []);

  const sendMessage = useCallback(async (params: SendMessageParams) => {
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await chat.sendMessage(
        params.message,
        params.model,
        params.conversationId,
        true,
        params.genId,
        params.attachmentFileId,
        controller.signal,
      );

      if (controller.signal.aborted) return;

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
        if (controller.signal.aborted) {
          reader.cancel();
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
          if (eventType === 'error') {
            throw new Error(data || '流式响应失败');
          }
          if (data === '[DONE]') continue;

          let parsed: { conversation_id?: string; content?: string; error?: string };
          try {
            parsed = JSON.parse(data);
          } catch {
            // skip unparseable chunks
            continue;
          }

          if (parsed.error) {
            throw new Error(parsed.error);
          }

          if (parsed.conversation_id && !params.conversationId) {
            params.onConversationCreated?.(parsed.conversation_id);
          }

          if (parsed.content) {
            fullContent += parsed.content;
            params.onToken?.(fullContent);
          }
        }
      }

      // Process any remaining data in the buffer after stream ends
      buffer += decoder.decode();
      const remaining = buffer.trim();
      if (remaining.startsWith('data: ')) {
        const data = remaining.slice(6).trim();
        if (data !== '[DONE]') {
          let parsed: { content?: string; error?: string } | null = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            // skip unparseable chunks
          }
          if (parsed?.error) {
            throw new Error(parsed.error);
          }
          if (parsed?.content) {
            fullContent += parsed.content;
            params.onToken?.(fullContent);
          }
        }
      }

      params.onDone?.(fullContent);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      params.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }, []);

  return { sending, sendMessage, cancelStream };
}
