import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { chat, type FileAsset, type ImageGroup, type Source, type UploadedFile } from '../api/client';
import { useChat } from '../hooks/useChat';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';

interface LocalMessage {
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
}

interface OutletContext {
  loadConversations: () => Promise<void>;
  announceConversation: (id: string, message: string, kind?: 'chat' | 'image') => void;
  refreshConversationTitle: (id: string) => Promise<void>;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { loadConversations, announceConversation, refreshConversationTitle } = useOutletContext<OutletContext>();
  const { sending, sendMessage, cancelStream } = useChat();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const streamMessageRef = useRef<string | null>(null);
  const pendingConversationRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);

  const updateStreamingMessage = useCallback((update: (message: LocalMessage) => LocalMessage) => {
    const targetID = streamMessageRef.current;
    setMessages((current) => current.map((message) => message.id === targetID ? update(message) : message));
  }, []);

  const callbacksFor = useCallback((newConversation: boolean, initialMessage = '') => ({
    onConversationCreated: (id: string) => {
      if (!newConversation || pendingConversationRef.current === id) return;
      pendingConversationRef.current = id;
      announceConversation(id, initialMessage, 'chat');
      void refreshConversationTitle(id);
    },
    onToken: (content: string) => updateStreamingMessage((message) => ({ ...message, content })),
    onImages: (images: FileAsset[]) => updateStreamingMessage((message) => {
      const merged = new Map((message.images || []).map((image) => [image.file_id, image]));
      images.forEach((image) => merged.set(image.file_id, image));
      return { ...message, images: [...merged.values()] };
    }),
    onStatus: (status: string) => updateStreamingMessage((message) => ({ ...message, status })),
    onReasoning: (reasoning: string) => updateStreamingMessage((message) => ({ ...message, reasoning })),
    onSources: (sources: Source[]) => updateStreamingMessage((message) => ({ ...message, sources })),
    onImageGroups: (image_groups: ImageGroup[]) => updateStreamingMessage((message) => ({ ...message, image_groups })),
    onMessageId: (upstreamId: string) => updateStreamingMessage((message) => ({ ...message, upstreamId })),
    onDone: () => {
      updateStreamingMessage((message) => ({ ...message, streaming: false, status: '', durationSeconds: Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)) }));
      streamMessageRef.current = null;
      const pending = pendingConversationRef.current;
      pendingConversationRef.current = null;
      if (pending && newConversation) navigate(`/chat/${pending}`, { replace: true });
      void loadConversations();
    },
    onError: (error: Error) => {
      updateStreamingMessage((message) => ({ ...message, content: message.content || `错误：${error.message}`, streaming: false, status: '' }));
      streamMessageRef.current = null;
      pendingConversationRef.current = null;
    },
  }), [announceConversation, loadConversations, navigate, refreshConversationTitle, updateStreamingMessage]);

  useEffect(() => {
    if (!conversationId) { setMessages([]); setLoadError(''); return; }
    setLoading(true);
    setLoadError('');
    void chat.getConversation(conversationId).then(({ data }) => {
      setMessages(data.messages.map((message, index) => ({
        ...message,
        id: message.id || `${conversationId}-${index}`,
        upstreamId: message.id,
        content: message.content || '',
        model: data.conversation.model,
      })));
    }).catch(() => setLoadError('加载消息失败，请重试')).finally(() => setLoading(false));
  }, [conversationId]);

  const handleSend = useCallback(async (text: string, model: string, thinkingEffort: string | undefined, attachments: UploadedFile[]) => {
    const now = Date.now();
    setMessages((current) => [...current, { id: `user-${now}`, role: 'user', content: text, attachments }]);
    const assistantID = `assistant-${now}`;
    setMessages((current) => [...current, { id: assistantID, role: 'assistant', content: '', streaming: true, status: '正在思考…', model, thinkingEffort }]);
    streamMessageRef.current = assistantID;
    startedAtRef.current = now;
    await sendMessage({ message: text, model, thinkingEffort, conversationId, attachments, ...callbacksFor(!conversationId, text) });
  }, [callbacksFor, conversationId, sendMessage]);

  const handleRetry = useCallback(async (messageID: string) => {
    if (!conversationId || sending) return;
    const target = messages.find((message) => message.id === messageID);
    if (!target) return;
    streamMessageRef.current = messageID;
    startedAtRef.current = Date.now();
    setMessages((current) => current.map((message) => message.id === messageID ? { ...message, content: '', reasoning: '', sources: [], streaming: true, status: '正在重新生成…' } : message));
    await sendMessage({
      message: '',
      model: target.model || 'gpt-5-6-thinking',
      thinkingEffort: target.thinkingEffort || 'max',
      conversationId,
      retryAssistantMessageId: target.upstreamId || target.id,
      ...callbacksFor(false),
    });
  }, [callbacksFor, conversationId, messages, sendMessage, sending]);

  return (
    <main className="main-content">
      {loading ? <div className="welcome-screen"><div className="spinner" /><p>加载中...</p></div>
        : loadError ? <div className="welcome-screen"><p className="page-error">{loadError}</p></div>
          : messages.length === 0 ? <div className="welcome-screen"><h2>ChatGPT Proxy</h2><p>开始一段新的对话</p></div>
            : <MessageList messages={messages} onRetry={handleRetry} />}
      <ChatInput onSend={handleSend} sending={sending} onCancel={cancelStream} />
    </main>
  );
}
