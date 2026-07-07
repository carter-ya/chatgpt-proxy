import type { Conversation } from '../api/client';
import { formatTime } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | null;
  sidebarOpen: boolean;
  onSelect: (conv: Conversation) => void;
  onNewChat: () => void;
}

export default function ConversationList({
  conversations,
  activeId,
  sidebarOpen,
  onSelect,
  onNewChat,
}: ConversationListProps) {
  const { user, logout } = useAuth();

  return (
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <button className="new-chat-btn" onClick={onNewChat}>
          + 新对话
        </button>
      </div>

      <div className="conversation-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item ${conv.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(conv)}
          >
            <span className="conv-title">{conv.title || '新对话'}</span>
            <span className="conv-time">{formatTime(conv.updated_at)}</span>
          </div>
        ))}
        {conversations.length === 0 && (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: '#8e8ea0',
              fontSize: 14,
            }}
          >
            暂无对话
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="user-info">
          <div className="user-avatar">
            {user?.email?.charAt(0).toUpperCase() || '?'}
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
