import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { chat, type Conversation } from '../api/client';
import ConversationList from './ConversationList';

function extractConversationId(pathname: string): string | undefined {
	const match = pathname.match(/^\/(?:chat|images)\/([^/]+)/);
  return match ? match[1] : undefined;
}

function temporaryTitle(message: string): string {
  const normalized = message
    .replace(/```[\s\S]*?```/g, '代码')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '新对话';
  return normalized.length > 30 ? `${normalized.slice(0, 30)}…` : normalized;
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
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const conversationRequestRef = useRef(0);

  const loadConversations = useCallback(async () => {
    const requestID = ++conversationRequestRef.current;
    setLoadingConversations(true);
    try {
      const res = await chat.listConversations(showArchived);
      if (requestID !== conversationRequestRef.current) return;
      const data = res.data;
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      setConversations(items);
      setLoadError(false);
    } catch {
      if (requestID !== conversationRequestRef.current) return;
      setLoadError(true);
    } finally {
      if (requestID === conversationRequestRef.current) {
        setLoadingConversations(false);
      }
    }
  }, [showArchived]);

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

  const announceConversation = useCallback((id: string, message: string, kind: 'chat' | 'image' = 'chat') => {
    if (showArchived) return;
    const now = new Date().toISOString();
    setConversations((current) => {
      const existing = current.find((item) => item.id === id);
      if (existing) return current.map((item) => item.id === id ? { ...item, title: item.title || temporaryTitle(message) } : item);
      return [{ id, title: temporaryTitle(message), model: '', kind, created_at: now, updated_at: now }, ...current];
    });
  }, [showArchived]);

  const refreshConversationTitle = useCallback(async (id: string) => {
    if (showArchived) return;
    const delays = [0, 1500, 3000];
    for (const delay of delays) {
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const { data } = await chat.listConversations(false);
        const match = data.items?.find((item) => item.id === id);
        const title = match?.title?.trim();
        if (!match || !title || title === 'New chat' || title === '新对话') continue;
        setConversations((current) => {
          const withoutMatch = current.filter((item) => item.id !== id);
          return [{ ...match, title }, ...withoutMatch];
        });
        return;
      } catch {
        // The normal list refresh at stream completion remains the fallback.
      }
    }
  }, [showArchived]);

  const handleToggleArchived = useCallback(() => {
    // Invalidate any in-flight response before changing views. Archived
    // upstream requests can be substantially slower than the normal list.
    conversationRequestRef.current += 1;
    setConversations([]);
    setLoadError(false);
    setLoadingConversations(true);
    setShowArchived((value) => !value);
  }, []);

  const handleArchive = useCallback(async (conv: Conversation) => {
    try {
      await chat.archiveConversation(conv.id, !showArchived);
      if (conversationId === conv.id) navigate('/chat', { replace: true });
      await loadConversations();
    } catch {
      window.alert(showArchived ? '恢复对话失败，请重试' : '归档对话失败，请重试');
    }
  }, [conversationId, loadConversations, navigate, showArchived]);

  const handleDelete = useCallback((conv: Conversation) => {
    setPendingDelete(conv);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await chat.deleteConversation(pendingDelete.id);
      if (conversationId === pendingDelete.id) navigate('/chat', { replace: true });
      setPendingDelete(null);
      await loadConversations();
    } catch {
      window.alert('删除对话失败，请重试');
    } finally {
      setDeleting(false);
    }
  }, [conversationId, deleting, loadConversations, navigate, pendingDelete]);

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
        loading={loadingConversations}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onOpenImages={handleOpenImages}
        archived={showArchived}
        onToggleArchived={handleToggleArchived}
        onArchive={handleArchive}
        onDelete={handleDelete}
        onRetry={loadConversations}
      />

      <Outlet context={{ loadConversations, announceConversation, refreshConversationTitle }} />

      {pendingDelete && (
        <div className="dialog-backdrop" role="presentation">
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
            <h3 id="delete-dialog-title">永久删除对话？</h3>
            <p id="delete-dialog-description">
              “{pendingDelete.title || '新对话'}”删除后无法恢复。
            </p>
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={deleting}>取消</button>
              <button type="button" className="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? '删除中…' : '永久删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
