import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { chat, type FileAsset, type Source, type UploadedFile } from '../api/client';
import ChatInput from '../components/ChatInput';
import MessageList from '../components/MessageList';
import { useChat } from '../hooks/useChat';

interface ImageMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  streaming?: boolean;
  status?: string;
  reasoning?: string;
  sources?: Source[];
  durationSeconds?: number;
  selectedImageID?: string;
}

interface OutletContext { loadConversations: () => Promise<void> }

export default function ImagesPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { loadConversations } = useOutletContext<OutletContext>();
  const { sending, sendMessage, cancelStream } = useChat();
  const [messages, setMessages] = useState<ImageMessage[]>([]);
  const [reference, setReference] = useState<FileAsset>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const streamID = useRef('');
  const startedAt = useRef(0);
  const pendingConversation = useRef('');

  useEffect(() => {
    if (!conversationId) { setMessages([]); return; }
    setLoading(true);
    void chat.getConversation(conversationId).then(({ data }) => {
      setMessages(data.messages.map((message, index) => ({ ...message, id: message.id || `${conversationId}-${index}`, content: message.content || '' })));
    }).catch(() => setError('加载图片对话失败')).finally(() => setLoading(false));
  }, [conversationId]);

  const updateStream = useCallback((update: (message: ImageMessage) => ImageMessage) => {
    const targetID = streamID.current;
    setMessages((current) => current.map((message) => message.id === targetID ? update(message) : message));
  }, []);

  const handleSend = useCallback(async (text: string, model: string, thinkingEffort: string | undefined, attachments: UploadedFile[]) => {
    setError('');
    const now = Date.now();
    const sentAttachments = reference ? [reference, ...attachments.filter((item) => item.file_id !== reference.file_id)] : attachments;
    setMessages((current) => [...current, { id: `user-${now}`, role: 'user', content: text, attachments: sentAttachments }]);
    const assistantID = `assistant-${now}`;
    setMessages((current) => [...current, { id: assistantID, role: 'assistant', content: '', streaming: true, status: reference ? '正在编辑图片…' : '正在生成图片…' }]);
    streamID.current = assistantID;
    startedAt.current = now;
    await sendMessage({
      message: text,
      model,
      thinkingEffort,
      conversationId,
      attachments,
      imageMode: true,
      imageReference: reference,
      onConversationCreated: (id) => { pendingConversation.current = id; },
      onToken: (content) => updateStream((message) => ({ ...message, content })),
      onImages: (images) => updateStream((message) => {
        const merged = new Map((message.images || []).map((image) => [image.file_id, image]));
        images.forEach((image) => merged.set(image.file_id, image));
        return { ...message, images: [...merged.values()] };
      }),
      onStatus: (status) => updateStream((message) => ({ ...message, status })),
      onReasoning: (reasoning) => updateStream((message) => ({ ...message, reasoning })),
      onSources: (sources) => updateStream((message) => ({ ...message, sources })),
      onDone: () => {
        updateStream((message) => ({ ...message, streaming: false, status: '', durationSeconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)) }));
        setReference(undefined);
        streamID.current = '';
        const created = pendingConversation.current;
        pendingConversation.current = '';
        if (created && !conversationId) navigate(`/images/${created}`, { replace: true });
        void loadConversations();
      },
      onError: (streamError) => {
        updateStream((message) => ({ ...message, content: `错误：${streamError.message}`, streaming: false, status: '' }));
        setError(streamError.message);
        streamID.current = '';
      },
    });
  }, [conversationId, loadConversations, navigate, reference, sendMessage, updateStream]);

  const selectImage = useCallback(async (messageID: string, image: FileAsset) => {
    if (!conversationId) return;
    setError('');
    try {
      await chat.selectImage(conversationId, image);
      setMessages((current) => current.map((message) => message.id === messageID ? { ...message, selectedImageID: image.file_id } : message));
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    }
  }, [conversationId]);

  return (
    <main className="main-content images-page">
      {error && <div className="image-error banner-error">{error}</div>}
      {loading ? <div className="welcome-screen"><div className="spinner" /><p>加载中...</p></div>
        : messages.length === 0 ? <div className="welcome-screen"><h2>图片创作</h2><p>描述想法、上传参考文件，或继续编辑生成结果</p></div>
          : <MessageList messages={messages} onUseImage={setReference} editingImageID={reference?.file_id} onSelectImage={selectImage} />}
      <ChatInput onSend={handleSend} sending={sending} onCancel={cancelStream} placeholder="描述图片，或继续和 ChatGPT 对话..." referenceImage={reference} onRemoveReference={() => setReference(undefined)} />
    </main>
  );
}
