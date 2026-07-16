import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ChatMessage from './ChatMessage';
import type { FileAsset, ImageGroup, Source } from '../api/client';

interface LocalMessage {
  id: string;
  upstreamId?: string;
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  streaming?: boolean;
  status?: string;
  reasoning?: string;
  sources?: Source[];
  image_groups?: ImageGroup[];
  durationSeconds?: number;
  selectedImageID?: string;
}

interface MessageListProps {
  messages: LocalMessage[];
  conversationId?: string;
  onRetry?: (messageID: string) => void;
  onUseImage?: (image: FileAsset) => void;
  editingImageID?: string;
  onSelectImage?: (messageID: string, image: FileAsset) => void;
}

export default function MessageList({ messages, conversationId, onRetry, onUseImage, editingImageID, onSelectImage }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const previousMessageCount = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const awayFromBottom = scrollHeight - scrollTop - clientHeight > 80;
      userScrolledUp.current = awayFromBottom;
      setShowScrollToBottom(awayFromBottom);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!userScrolledUp.current) {
      const initialHistoryLoad = previousMessageCount.current === 0 && messages.length > 0;
      bottomRef.current?.scrollIntoView({ behavior: initialHistoryLoad ? 'auto' : 'smooth' });
    }
    previousMessageCount.current = messages.length;
  }, [messages]);

  const scrollToBottom = () => {
    userScrolledUp.current = false;
    setShowScrollToBottom(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={containerRef}>
        <div className="message-list-inner">
          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              conversationId={conversationId}
              upstreamMessageId={msg.upstreamId || msg.id}
              role={msg.role}
              content={msg.content}
              images={msg.images}
              attachments={msg.attachments}
              streaming={msg.streaming}
              status={msg.status}
              reasoning={msg.reasoning}
              sources={msg.sources}
              imageGroups={msg.image_groups}
              durationSeconds={msg.durationSeconds}
              selectedImageID={msg.selectedImageID}
              editingImageID={editingImageID}
              onRetry={msg.role === 'assistant' && onRetry ? () => onRetry(msg.id) : undefined}
              onUseImage={onUseImage}
              onSelectImage={onSelectImage ? (image) => onSelectImage(msg.id, image) : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          className="scroll-to-bottom"
          aria-label="滚动到底部"
          title="滚动到底部"
          onClick={scrollToBottom}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v15m0 0-6-6m6 6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}
