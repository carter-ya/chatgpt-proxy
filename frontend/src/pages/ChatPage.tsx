import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { chat } from '../api/client';
import type { FileAsset, UploadedFile } from '../api/client';
import { useChat } from '../hooks/useChat';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  streaming?: boolean;
}

interface OutletContext {
  loadConversations: () => Promise<void>;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { sending, sendMessage, cancelStream } = useChat();
  const { loadConversations } = useOutletContext<OutletContext>();

  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const streamMsgIdRef = useRef<string | null>(null);
  const pendingConversationIdRef = useRef<string | null>(null);

  const loadMessages = useCallback(async (convId: string) => {
    setLoadingMessages(true);
    try {
      const res = await chat.getConversation(convId);
      const msgs: LocalMessage[] = res.data.messages.map((m, i) => ({
        id: `${convId}-${i}-${m.role}`,
        role: m.role,
        content: m.content,
        images: m.images,
        attachments: m.attachments,
      }));
      setMessages(msgs);
    } catch {
      setLoadError('加载消息失败，请重试');
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (conversationId) {
      setMessages([]);
      setLoadError(null);
      loadMessages(conversationId);
    } else {
      setMessages([]);
      setLoadError(null);
    }
  }, [conversationId, loadMessages]);

  const handleSend = useCallback(
    async (text: string, model: string, genId?: string, attachment?: UploadedFile) => {
      const userMsg: LocalMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
      };
      setMessages((prev) => [...prev, userMsg]);

      const assistantMsgId = `assistant-${Date.now()}`;
      const assistantMsg: LocalMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        streaming: true,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      streamMsgIdRef.current = assistantMsgId;

      await sendMessage({
        message: text,
        model,
        conversationId: conversationId || undefined,
        genId: genId || undefined,
        attachment,
        onConversationCreated: (newConvId) => {
          if (!conversationId) {
            pendingConversationIdRef.current = newConvId;
          }
        },
        onToken: (fullContent) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamMsgIdRef.current
                ? { ...m, content: fullContent }
                : m,
            ),
          );
        },
        onImages: (images) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== streamMsgIdRef.current) return m;
              const existing = new Map((m.images || []).map((image) => [image.file_id, image]));
              images.forEach((image) => existing.set(image.file_id, image));
              return { ...m, images: Array.from(existing.values()) };
            }),
          );
        },
        onDone: () => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamMsgIdRef.current
                ? { ...m, streaming: false }
                : m,
            ),
          );
          streamMsgIdRef.current = null;
          const pendingConversationId = pendingConversationIdRef.current;
          pendingConversationIdRef.current = null;
          if (pendingConversationId && !conversationId) {
            navigate(`/chat/${pendingConversationId}`, { replace: true });
          }
          loadConversations();
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamMsgIdRef.current
                ? { ...m, content: `错误: ${err.message}`, streaming: false }
                : m,
            ),
          );
          streamMsgIdRef.current = null;
          pendingConversationIdRef.current = null;
        },
      });
    },
    [conversationId, navigate, sendMessage, loadConversations],
  );

  return (
    <div className="main-content">
      {loadingMessages ? (
        <div className="welcome-screen">
          <div className="spinner" />
          <p style={{ marginTop: 16 }}>加载中...</p>
        </div>
      ) : loadError ? (
        <div className="welcome-screen">
          <p style={{ color: '#e53e3e', fontSize: 16 }}>{loadError}</p>
        </div>
      ) : messages.length === 0 ? (
        <div className="welcome-screen">
          <h2>ChatGPT Proxy</h2>
          <p>开始一段新的对话</p>
        </div>
      ) : (
        <MessageList messages={messages} />
      )}

      <ChatInput
        onSend={handleSend}
        sending={sending}
        onCancel={cancelStream}
      />
    </div>
  );
}
