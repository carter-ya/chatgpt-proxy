import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { chat, type FileAsset, type UploadedFile } from '../api/client';
import { conversationTaskKey, useConversationRuntime } from '../contexts/ConversationRuntimeContext';
import ChatInput from '../components/ChatInput';
import MessageList from '../components/MessageList';

export default function ImagesPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { tasks, startTask, cancelTask, loadConversation, patchMessage } = useConversationRuntime();
  const task = tasks[conversationTaskKey('image', conversationId)];
  const messages = task?.messages || [];
  const sending = task?.sending || false;
  const [reference, setReference] = useState<FileAsset>();
  const [selectionError, setSelectionError] = useState('');

  useEffect(() => {
    if (conversationId) void loadConversation('image', conversationId);
  }, [conversationId, loadConversation]);

  const handleSend = useCallback(async (text: string, model: string, thinkingEffort: string | undefined, attachments: UploadedFile[]) => {
    setSelectionError('');
    await startTask({ kind: 'image', conversationId, text, model, thinkingEffort, attachments, imageReference: reference });
    setReference(undefined);
  }, [conversationId, reference, startTask]);

  const selectImage = useCallback(async (messageId: string, image: FileAsset) => {
    if (!conversationId) return;
    setSelectionError('');
    try {
      await chat.selectImage(conversationId, image);
      patchMessage('image', conversationId, messageId, (message) => ({ ...message, selectedImageID: image.file_id }));
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error));
    }
  }, [conversationId, patchMessage]);

  const error = selectionError || task?.error || '';
  return (
    <main className="main-content images-page">
      {error && <div className="image-error banner-error">{error}</div>}
      {task?.loading ? <div className="welcome-screen"><div className="spinner" /><p>加载中...</p></div>
        : task?.loadError ? <div className="welcome-screen"><p className="page-error">{task.loadError}</p></div>
          : messages.length === 0 ? <div className="welcome-screen"><h2>图片创作</h2><p>描述想法、上传参考文件，或继续编辑生成结果</p></div>
            : <MessageList messages={messages} conversationId={conversationId} onUseImage={setReference} editingImageID={reference?.file_id} onSelectImage={selectImage} />}
      <ChatInput onSend={handleSend} sending={sending} onCancel={() => cancelTask('image', conversationId)} placeholder="描述图片，或继续和 ChatGPT 对话..." referenceImage={reference} onRemoveReference={() => setReference(undefined)} />
    </main>
  );
}
