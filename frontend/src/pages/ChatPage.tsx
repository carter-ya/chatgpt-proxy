import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { chat, type Conversation } from '../api/client';
import { useChat } from '../hooks/useChat';
import ConversationList from '../components/ConversationList';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  streaming?: boolean;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { sending, sendMessage, cancelStream } = useChat();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    conversationId || null,
  );
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const streamMsgIdRef = useRef<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await chat.listConversations();
      setConversations(res.data);
    } catch {
      // ignore load errors
    }
  }, []);

  const loadMessages = useCallback(async (convId: string) => {
    setLoadingMessages(true);
    try {
      const res = await chat.getConversation(convId);
      const msgs: LocalMessage[] = res.data.messages.map((m, i) => ({
        id: `${convId}-${i}-${m.role}`,
        role: m.role,
        content: m.content,
        images: m.images,
      }));
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (conversationId && conversationId !== activeConversationId) {
      setActiveConversationId(conversationId);
      loadMessages(conversationId);
    }
  }, [conversationId, activeConversationId, loadMessages]);

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setActiveConversationId(conv.id);
      setSidebarOpen(false);
      navigate(`/chat/${conv.id}`, { replace: true });
    },
    [navigate],
  );

  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setSidebarOpen(false);
    navigate('/chat', { replace: true });
  }, [navigate]);

  const handleSend = useCallback(
    async (text: string, model: string, genId?: string, attachmentFileId?: string) => {
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
        conversationId: activeConversationId || undefined,
        genId: genId || undefined,
        attachmentFileId: attachmentFileId || undefined,
        onConversationCreated: (newConvId) => {
          setActiveConversationId(newConvId);
          navigate(`/chat/${newConvId}`, { replace: true });
          loadConversations();
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
        onDone: () => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamMsgIdRef.current
                ? { ...m, streaming: false }
                : m,
            ),
          );
          streamMsgIdRef.current = null;
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
        },
      });
    },
    [activeConversationId, navigate, sendMessage, loadConversations],
  );

  return (
    <div className="chat-page">
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label="切换侧边栏"
      >
        ☰
      </button>

      <div
        className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <ConversationList
        conversations={conversations}
        activeId={activeConversationId}
        sidebarOpen={sidebarOpen}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
      />

      <div className="main-content">
        {loadingMessages ? (
          <div className="welcome-screen">
            <div className="spinner" />
            <p style={{ marginTop: 16 }}>加载中...</p>
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
    </div>
  );
}
