import { useState, useEffect, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { chat, type Conversation } from '../api/client';
import ConversationList from './ConversationList';

function extractConversationId(pathname: string): string | undefined {
	const match = pathname.match(/^\/(?:chat|images)\/([^/]+)/);
  return match ? match[1] : undefined;
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const conversationId = useMemo(
    () => extractConversationId(location.pathname),
    [location.pathname],
  );

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const res = await chat.listConversations();
      const data = res.data;
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      setConversations(items);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setSidebarOpen(false);
      navigate(`/${conv.kind === 'image' ? 'images' : 'chat'}/${conv.id}`, { replace: true });
    },
    [navigate],
  );

  const handleNewChat = useCallback(() => {
    setSidebarOpen(false);
    navigate('/chat', { replace: true });
  }, [navigate]);

  const handleOpenImages = useCallback(() => {
    setSidebarOpen(false);
    navigate('/images', { replace: true });
  }, [navigate]);

  return (
    <div className="layout">
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
        activeId={conversationId || null}
        sidebarOpen={sidebarOpen}
        loadError={loadError}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onOpenImages={handleOpenImages}
      />

      <Outlet context={{ loadConversations }} />
    </div>
  );
}
