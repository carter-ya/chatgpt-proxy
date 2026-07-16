import { useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import type { UploadedFile } from '../api/client';
import { conversationTaskKey, useConversationRuntime } from '../contexts/ConversationRuntimeContext';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { tasks, startTask, cancelTask, loadConversation } = useConversationRuntime();
  const task = tasks[conversationTaskKey('chat', conversationId)];
  const messages = task?.messages || [];
  const sending = task?.sending || false;

  useEffect(() => {
    if (conversationId) void loadConversation('chat', conversationId);
  }, [conversationId, loadConversation]);

  const handleSend = useCallback(async (text: string, model: string, thinkingEffort: string | undefined, attachments: UploadedFile[]) => {
    await startTask({ kind: 'chat', conversationId, text, model, thinkingEffort, attachments });
  }, [conversationId, startTask]);

  const handleRetry = useCallback(async (messageId: string) => {
    if (!conversationId || sending) return;
    const target = messages.find((message) => message.id === messageId);
    if (!target) return;
    await startTask({
      kind: 'chat',
      conversationId,
      text: '',
      model: target.model || 'gpt-5-6-thinking',
      thinkingEffort: target.thinkingEffort || 'max',
      attachments: [],
      retryAssistantMessageId: target.upstreamId || target.id,
      retryLocalMessageId: target.id,
    });
  }, [conversationId, messages, sending, startTask]);

  return (
    <main className="main-content">
      {task?.loading ? <div className="welcome-screen"><div className="spinner" /><p>加载中...</p></div>
        : task?.loadError ? <div className="welcome-screen"><p className="page-error">{task.loadError}</p></div>
          : messages.length === 0 ? <div className="welcome-screen"><h2>ChatGPT Proxy</h2><p>开始一段新的对话</p></div>
            : <MessageList messages={messages} conversationId={conversationId} onRetry={handleRetry} />}
      <ChatInput onSend={handleSend} sending={sending} onCancel={() => cancelTask('chat', conversationId)} />
    </main>
  );
}
