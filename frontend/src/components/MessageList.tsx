import { useEffect, useLayoutEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import type { FileAsset, ImageGroup, Source } from '../api/client';

interface LocalMessage {
  id: string;
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
  onRetry?: (messageID: string) => void;
  onUseImage?: (image: FileAsset) => void;
  editingImageID?: string;
  onSelectImage?: (messageID: string, image: FileAsset) => void;
}

export default function MessageList({ messages, onRetry, onUseImage, editingImageID, onSelectImage }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const previousMessageCount = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      userScrolledUp.current = scrollTop + clientHeight < scrollHeight - 60;
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

  return (
    <div className="message-list" ref={containerRef}>
      <div className="message-list-inner">
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
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
  );
}
