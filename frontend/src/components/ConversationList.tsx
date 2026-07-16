import type { Conversation } from '../api/client';
import { formatTime, getAvatarLetter } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | null;
  sidebarOpen: boolean;
  loadError?: boolean;
  loading?: boolean;
  onSelect: (conv: Conversation) => void;
  onNewChat: () => void;
  onOpenImages: () => void;
  archived: boolean;
  onToggleArchived: () => void;
  onArchive: (conv: Conversation) => void;
  onDelete: (conv: Conversation) => void;
  onRetry: () => void;
  errorAttentionIds: Set<string>;
}

export default function ConversationList({
  conversations,
  activeId,
  sidebarOpen,
  loadError,
  loading,
  onSelect,
  onNewChat,
  onOpenImages,
  archived,
  onToggleArchived,
  onArchive,
  onDelete,
  onRetry,
  errorAttentionIds,
}: ConversationListProps) {
  const { user, logout } = useAuth();

  return (
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <button className="new-chat-btn" onClick={onNewChat}>
          + 新对话
        </button>
        <button className="images-btn" onClick={onOpenImages}>
          图片
        </button>
        <button className={`images-btn ${archived ? 'active' : ''}`} onClick={onToggleArchived}>
          {archived ? '返回聊天记录' : '已归档'}
        </button>
      </div>

      <div className="conversation-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item ${conv.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(conv)}
          >
            {errorAttentionIds.has(conv.id) ? (
              <span className="conv-attention error" role="img" aria-label="任务失败" title="任务失败" />
            ) : conv.async_status === 4 ? (
              <span className="conv-attention" role="img" aria-label="有新回复" title="有新回复" />
            ) : null}
            <span className="conv-title">{conv.title || '新对话'}</span>
            <span className="conv-time">{formatTime(conv.updated_at)}</span>
            <div className="conv-actions">
              <button
                onClick={(event) => { event.stopPropagation(); onArchive(conv); }}
                title={archived ? '恢复' : '归档'}
                aria-label={archived ? '恢复对话' : '归档对话'}
              >{archived ? '↩' : '归档'}</button>
              <button
                className="danger"
                onClick={(event) => { event.stopPropagation(); onDelete(conv); }}
                title="永久删除"
                aria-label="永久删除对话"
              >删除</button>
            </div>
          </div>
        ))}
        {conversations.length === 0 && loading && (
          <div className="conversation-list-state">
            <div className="spinner" />
            <span>加载中...</span>
          </div>
        )}
        {conversations.length === 0 && !loading && loadError && (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: '#d32f2f',
              fontSize: 14,
            }}
          >
            加载失败
            <button className="conversation-retry-btn" onClick={onRetry}>重试</button>
          </div>
        )}
        {conversations.length === 0 && !loading && !loadError && (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: '#8e8ea0',
              fontSize: 14,
            }}
          >
            {archived ? '暂无已归档对话' : '暂无对话'}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="user-info">
          <div className="user-avatar">
            {getAvatarLetter(user?.email)}
          </div>
          <span className="user-email">{user?.email || ''}</span>
          <button
            className="logout-btn"
            onClick={logout}
            aria-label="退出登录"
            title="退出登录"
          >
            ⏻
          </button>
        </div>
      </div>
    </aside>
  );
}
