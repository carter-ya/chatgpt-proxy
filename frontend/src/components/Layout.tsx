import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { chat, type Conversation } from '../api/client';
import ConversationList from './ConversationList';
import { ConversationRuntimeProvider, type ConversationKind, type TaskSettledEvent } from '../contexts/ConversationRuntimeContext';

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
  const [errorAttentionIds, setErrorAttentionIds] = useState<Set<string>>(() => new Set());
  const conversationRequestRef = useRef(0);
  const conversationsRef = useRef<Conversation[]>([]);
  const asyncStatusAcknowledgementsRef = useRef(new Set<string>());

  useEffect(() => {
    conversationsRef.current = conversations;
    const attentionIds = new Set(conversations.filter((item) => item.async_status === 4).map((item) => item.id));
    asyncStatusAcknowledgementsRef.current.forEach((id) => {
      if (!attentionIds.has(id)) asyncStatusAcknowledgementsRef.current.delete(id);
    });
  }, [conversations]);

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

  const acknowledgeAsyncStatus = useCallback((id: string) => {
    if (asyncStatusAcknowledgementsRef.current.has(id)) return;
    asyncStatusAcknowledgementsRef.current.add(id);
    void chat.acknowledgeAsyncStatus(id)
      .then(loadConversations)
      .catch(() => asyncStatusAcknowledgementsRef.current.delete(id));
  }, [loadConversations]);

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setSidebarOpen(false);
      setErrorAttentionIds((current) => {
        if (!current.has(conv.id)) return current;
        const next = new Set(current);
        next.delete(conv.id);
        return next;
      });
      if (conv.async_status === 4) {
        acknowledgeAsyncStatus(conv.id);
      }
      navigate(`/${conv.kind === 'image' ? 'images' : 'chat'}/${conv.id}`, { replace: true });
    },
    [acknowledgeAsyncStatus, navigate],
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

  const requestNotificationPermission = useCallback(() => {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
    } catch {
      // Notification support is optional; the sidebar attention state remains.
    }
  }, []);

  const showTaskNotification = useCallback((event: TaskSettledEvent) => {
    if (!event.conversationId || !('Notification' in window) || Notification.permission !== 'granted') return;
    const conversation = conversationsRef.current.find((item) => item.id === event.conversationId);
    const title = conversation?.title?.trim() || temporaryTitle(event.titleHint || '');
    const body = event.outcome === 'error'
      ? '任务失败'
      : event.kind === 'image' ? '图片已生成' : '回复已完成';
    try {
      const notification = new Notification(title, {
        body,
        icon: '/favicon.png',
        tag: `conversation-${event.conversationId}`,
      });
      notification.onclick = () => {
        window.focus();
        navigate(`/${event.kind === 'image' ? 'images' : 'chat'}/${event.conversationId}`, { replace: true });
        notification.close();
      };
    } catch {
      // Some browsers can still reject construction after permission was granted.
    }
  }, [navigate]);

  const handleRuntimeConversationCreated = useCallback((id: string, message: string, kind: ConversationKind, originPath: string) => {
    announceConversation(id, message, kind);
    if (window.location.pathname === originPath) {
      navigate(`/${kind === 'image' ? 'images' : 'chat'}/${id}`, { replace: true });
    }
    void refreshConversationTitle(id);
  }, [announceConversation, navigate, refreshConversationTitle]);

  const handleTaskSettled = useCallback((event: TaskSettledEvent) => {
    const pageVisible = document.visibilityState === 'visible' && document.hasFocus();
    const isCurrentConversation = Boolean(event.conversationId && event.conversationId === conversationId);

    if (event.outcome === 'error' && event.conversationId && !(pageVisible && isCurrentConversation)) {
      setErrorAttentionIds((current) => new Set(current).add(event.conversationId!));
    }
    if (!pageVisible) showTaskNotification(event);

    if (event.outcome === 'success' && event.conversationId && pageVisible && isCurrentConversation) {
      acknowledgeAsyncStatus(event.conversationId);
      return;
    }
    void loadConversations();
  }, [acknowledgeAsyncStatus, conversationId, loadConversations, showTaskNotification]);

  useEffect(() => {
    const reviewVisibleConversation = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || !conversationId) return;
      setErrorAttentionIds((current) => {
        if (!current.has(conversationId)) return current;
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (conversation?.async_status === 4) {
        acknowledgeAsyncStatus(conversationId);
      }
    };
    window.addEventListener('focus', reviewVisibleConversation);
    document.addEventListener('visibilitychange', reviewVisibleConversation);
    reviewVisibleConversation();
    return () => {
      window.removeEventListener('focus', reviewVisibleConversation);
      document.removeEventListener('visibilitychange', reviewVisibleConversation);
    };
  }, [acknowledgeAsyncStatus, conversationId, conversations]);

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
    <ConversationRuntimeProvider
      onTaskStarted={requestNotificationPermission}
      onConversationCreated={handleRuntimeConversationCreated}
      onTaskSettled={handleTaskSettled}
    >
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
        errorAttentionIds={errorAttentionIds}
      />

      <Outlet />

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
    </ConversationRuntimeProvider>
  );
}
