import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { chat, type FileAsset, type ImageGroup, type Source, type UploadedFile } from '../api/client';
import { streamMessage } from '../hooks/useChat';

export type ConversationKind = 'chat' | 'image';

export interface RuntimeMessage {
  id: string;
  upstreamId?: string;
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  streaming?: boolean;
  status?: string;
  reasoning?: string;
  sources?: Source[];
  image_groups?: ImageGroup[];
  durationSeconds?: number;
  model?: string;
  thinkingEffort?: string;
  selectedImageID?: string;
}

export interface ConversationTask {
  messages: RuntimeMessage[];
  sending: boolean;
  loading: boolean;
  loadError: string;
  error: string;
}

interface StartTaskInput {
  kind: ConversationKind;
  conversationId?: string;
  text: string;
  model: string;
  thinkingEffort?: string;
  attachments: UploadedFile[];
  imageReference?: FileAsset;
  retryAssistantMessageId?: string;
  retryLocalMessageId?: string;
}

export interface TaskSettledEvent {
  kind: ConversationKind;
  conversationId?: string;
  outcome: 'success' | 'error';
  error?: string;
  titleHint?: string;
}

interface RuntimeContextValue {
  tasks: Record<string, ConversationTask>;
  startTask: (input: StartTaskInput) => Promise<void>;
  cancelTask: (kind: ConversationKind, conversationId?: string) => void;
  loadConversation: (kind: ConversationKind, conversationId: string) => Promise<void>;
  patchMessage: (kind: ConversationKind, conversationId: string, messageId: string, update: (message: RuntimeMessage) => RuntimeMessage) => void;
}

interface ProviderProps {
  children: ReactNode;
  onTaskStarted: () => void;
  onConversationCreated: (id: string, message: string, kind: ConversationKind, originPath: string) => void;
  onTaskSettled: (event: TaskSettledEvent) => void;
}

const ConversationRuntimeContext = createContext<RuntimeContextValue | null>(null);

export function conversationTaskKey(kind: ConversationKind, conversationId?: string): string {
  return `${kind}:${conversationId || 'new'}`;
}

const emptyTask = (): ConversationTask => ({ messages: [], sending: false, loading: false, loadError: '', error: '' });

export function ConversationRuntimeProvider({ children, onTaskStarted, onConversationCreated, onTaskSettled }: ProviderProps) {
  const [tasks, setTasks] = useState<Record<string, ConversationTask>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const loadRequests = useRef(new Map<string, number>());
  const callbacks = useRef({ onTaskStarted, onConversationCreated, onTaskSettled });
  callbacks.current = { onTaskStarted, onConversationCreated, onTaskSettled };

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
  }, []);

  const updateTask = useCallback((key: string, update: (task: ConversationTask) => ConversationTask) => {
    setTasks((current) => ({ ...current, [key]: update(current[key] || emptyTask()) }));
  }, []);

  const patchMessage = useCallback((kind: ConversationKind, conversationId: string, messageId: string, update: (message: RuntimeMessage) => RuntimeMessage) => {
    const key = conversationTaskKey(kind, conversationId);
    updateTask(key, (task) => ({ ...task, messages: task.messages.map((message) => message.id === messageId ? update(message) : message) }));
  }, [updateTask]);

  const loadConversation = useCallback(async (kind: ConversationKind, conversationId: string) => {
    const key = conversationTaskKey(kind, conversationId);
    if (controllers.current.has(key)) return;
    const requestId = (loadRequests.current.get(key) || 0) + 1;
    loadRequests.current.set(key, requestId);
    updateTask(key, (task) => ({ ...task, loading: true, loadError: '', error: '' }));
    try {
      const { data } = await chat.getConversation(conversationId);
      if (loadRequests.current.get(key) !== requestId || controllers.current.has(key)) return;
      const messages = data.messages.map((message, index): RuntimeMessage => ({
        ...message,
        id: message.id || `${conversationId}-${index}`,
        upstreamId: message.id,
        content: message.content || '',
        model: data.conversation.model,
      }));
      updateTask(key, (task) => ({ ...task, messages, loading: false, loadError: '', error: '' }));
    } catch {
      if (loadRequests.current.get(key) !== requestId) return;
      updateTask(key, (task) => ({ ...task, loading: false, loadError: kind === 'image' ? '加载图片对话失败' : '加载消息失败，请重试' }));
    }
  }, [updateTask]);

  const startTask = useCallback(async (input: StartTaskInput) => {
    const initialKey = conversationTaskKey(input.kind, input.conversationId);
    if (controllers.current.has(initialKey)) return;
    try {
      callbacks.current.onTaskStarted();
    } catch (error) {
      console.warn('[conversation runtime] notification permission request failed', error);
    }

    const now = Date.now();
    const assistantId = input.retryLocalMessageId || `assistant-${now}`;
    const initialStatus = input.retryAssistantMessageId
      ? '正在重新生成…'
      : input.kind === 'image'
        ? input.imageReference ? '正在编辑图片…' : '正在生成图片…'
        : '正在思考…';
    const sentAttachments = input.kind === 'image' && input.imageReference
      ? [input.imageReference, ...input.attachments.filter((item) => item.file_id !== input.imageReference?.file_id)]
      : input.attachments;

    updateTask(initialKey, (task) => {
      if (input.retryLocalMessageId) {
        return {
          ...task,
          sending: true,
          error: '',
          messages: task.messages.map((message) => message.id === assistantId
            ? { ...message, content: '', reasoning: '', sources: [], streaming: true, status: initialStatus }
            : message),
        };
      }
      return {
        ...task,
        sending: true,
        loading: false,
        loadError: '',
        error: '',
        messages: [
          ...task.messages,
          { id: `user-${now}`, role: 'user', content: input.text, attachments: sentAttachments },
          { id: assistantId, role: 'assistant', content: '', streaming: true, status: initialStatus, model: input.model, thinkingEffort: input.thinkingEffort },
        ],
      };
    });

    const controller = new AbortController();
    controllers.current.set(initialKey, controller);
    let currentKey = initialKey;
    let currentConversationId = input.conversationId;
    let announced = Boolean(input.conversationId);
    const originPath = window.location.pathname;

    const updateStreamingMessage = (update: (message: RuntimeMessage) => RuntimeMessage) => {
      updateTask(currentKey, (task) => ({ ...task, messages: task.messages.map((message) => message.id === assistantId ? update(message) : message) }));
    };

    await streamMessage({
      message: input.retryAssistantMessageId ? '' : input.text,
      model: input.model,
      thinkingEffort: input.thinkingEffort,
      conversationId: input.conversationId,
      attachments: input.attachments,
      retryAssistantMessageId: input.retryAssistantMessageId,
      imageMode: input.kind === 'image',
      imageReference: input.imageReference,
      onConversationCreated: (id) => {
        if (announced) return;
        announced = true;
        currentConversationId = id;
        const nextKey = conversationTaskKey(input.kind, id);
        const previousKey = currentKey;
        controllers.current.delete(previousKey);
        controllers.current.set(nextKey, controller);
        setTasks((current) => {
          const task = current[previousKey] || emptyTask();
          const next = { ...current };
          delete next[previousKey];
          next[nextKey] = task;
          return next;
        });
        currentKey = nextKey;
        try {
          callbacks.current.onConversationCreated(id, input.text, input.kind, originPath);
        } catch (error) {
          console.error('[conversation runtime] conversation-created callback failed', error);
        }
      },
      onToken: (content) => updateStreamingMessage((message) => ({ ...message, content })),
      onImages: (images) => updateStreamingMessage((message) => {
        const merged = new Map((message.images || []).map((image) => [image.file_id, image]));
        images.forEach((image) => merged.set(image.file_id, image));
        return { ...message, images: [...merged.values()] };
      }),
      onStatus: (status) => updateStreamingMessage((message) => ({ ...message, status })),
      onReasoning: (reasoning) => updateStreamingMessage((message) => ({ ...message, reasoning })),
      onSources: (sources) => updateStreamingMessage((message) => ({ ...message, sources })),
      onImageGroups: (imageGroups) => updateStreamingMessage((message) => ({ ...message, image_groups: imageGroups })),
      onMessageId: (upstreamId) => updateStreamingMessage((message) => ({ ...message, upstreamId })),
      onDone: () => {
        updateStreamingMessage((message) => ({ ...message, streaming: false, status: '', durationSeconds: Math.max(1, Math.round((Date.now() - now) / 1000)) }));
        updateTask(currentKey, (task) => ({ ...task, sending: false, error: '' }));
        try {
          callbacks.current.onTaskSettled({ kind: input.kind, conversationId: currentConversationId, outcome: 'success', titleHint: input.text });
        } catch (error) {
          console.error('[conversation runtime] task-settled callback failed', error);
        }
      },
      onError: (error) => {
        updateStreamingMessage((message) => ({ ...message, content: message.content || `错误：${error.message}`, streaming: false, status: '' }));
        updateTask(currentKey, (task) => ({ ...task, sending: false, error: error.message }));
        try {
          callbacks.current.onTaskSettled({ kind: input.kind, conversationId: currentConversationId, outcome: 'error', error: error.message, titleHint: input.text });
        } catch (callbackError) {
          console.error('[conversation runtime] task-settled callback failed', callbackError);
        }
      },
    }, controller.signal);

    controllers.current.delete(currentKey);
    updateTask(currentKey, (task) => task.sending ? { ...task, sending: false } : task);
  }, [updateTask]);

  const cancelTask = useCallback((kind: ConversationKind, conversationId?: string) => {
    const key = conversationTaskKey(kind, conversationId);
    const controller = controllers.current.get(key);
    if (!controller) return;
    controller.abort();
    controllers.current.delete(key);
    updateTask(key, (task) => ({
      ...task,
      sending: false,
      messages: task.messages.map((message) => message.streaming ? { ...message, streaming: false, status: '' } : message),
    }));
  }, [updateTask]);

  const value = useMemo(() => ({ tasks, startTask, cancelTask, loadConversation, patchMessage }), [cancelTask, loadConversation, patchMessage, startTask, tasks]);
  return <ConversationRuntimeContext.Provider value={value}>{children}</ConversationRuntimeContext.Provider>;
}

export function useConversationRuntime(): RuntimeContextValue {
  const context = useContext(ConversationRuntimeContext);
  if (!context) throw new Error('useConversationRuntime must be used inside ConversationRuntimeProvider');
  return context;
}
