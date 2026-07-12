import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';
import { extractImages, sanitizeCitations } from '../utils/format';
import { chat, type FileAsset, type Source } from '../api/client';

interface ChatMessageProps {
  id?: string;
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
  editingImageID?: string;
  onRetry?: () => void;
  onUseImage?: (image: FileAsset) => void;
  onSelectImage?: (image: FileAsset) => void;
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    return match ? (
      <SyntaxHighlighter style={dracula} language={match[1]} PreTag="div" customStyle={{ margin: 0, borderRadius: 8 }}>{code}</SyntaxHighlighter>
    ) : <code className={className} {...props}>{children}</code>;
  },
};

const imageExtensionPattern = /\.(?:avif|gif|heic|heif|jpe?g|png|svg|webp)$/i;

function isImageFile(file: FileAsset): boolean {
  return file.mime_type.startsWith('image/') || imageExtensionPattern.test(file.file_name);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function AuthenticatedImage({ image, selected, editing, onUse, onSelect }: { image: FileAsset; selected: boolean; editing?: boolean; onUse?: () => void; onSelect?: () => void }) {
  const [src, setSrc] = useState('');
  const [shouldLoad, setShouldLoad] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [image.file_id]);

  useEffect(() => {
    if (!shouldLoad) return;
    let objectURL = '';
    let cancelled = false;
    void chat.getFileBlob(image).then((blob) => {
      if (cancelled) return;
      objectURL = URL.createObjectURL(blob);
      setSrc(objectURL);
    }).catch(() => setSrc(''));
    return () => { cancelled = true; if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [image.download_url, shouldLoad]);

  useEffect(() => {
    if (!previewOpen) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [previewOpen]);

  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 4 / 3;
  const frameStyle = { aspectRatio: String(ratio), '--image-aspect-ratio': ratio } as CSSProperties;
  return (
    <div ref={containerRef} className={`message-image-container ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`}>
      <div className="message-image-frame" style={frameStyle}>
        {src
          ? <button type="button" className="message-image-preview" onClick={() => setPreviewOpen(true)} aria-label={`查看原图 ${image.file_name}`}><img src={src} alt={image.file_name} className="message-image" loading="lazy" decoding="async" /></button>
          : <div className="image-placeholder">{shouldLoad && <span className="spinner" />}</div>}
      </div>
      <div className="image-actions">
        <button type="button" onClick={() => void chat.downloadFile(image)}>下载</button>
        {onUse && <button type="button" className={editing ? 'active' : ''} onClick={onUse} aria-pressed={editing}>{editing ? '已选为编辑原图' : '以此图编辑'}</button>}
        {onSelect && <button type="button" onClick={onSelect}>{selected ? '已选择' : '选择'}</button>}
      </div>
      {previewOpen && src && createPortal(<div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`原图预览 ${image.file_name}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setPreviewOpen(false); }}>
        <button type="button" className="image-lightbox-close" onClick={() => setPreviewOpen(false)} aria-label="关闭原图预览">×</button>
        <img src={src} alt={image.file_name} />
      </div>, document.body)}
    </div>
  );
}

export default function ChatMessage({ role, content, images = [], attachments = [], streaming, status, reasoning, sources = [], durationSeconds, selectedImageID, editingImageID, onRetry, onUseImage, onSelectImage }: ChatMessageProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const publicImages = role === 'assistant' ? extractImages(content) : [];
  const normalizedReasoning = reasoning?.trim() || '';
  const hasReasoningDetails = Boolean(normalizedReasoning && normalizedReasoning !== status?.trim());
  const showReasoningPanel = role === 'assistant' && Boolean(streaming || status || normalizedReasoning || durationSeconds !== undefined);
  const imageAttachments = attachments.filter(isImageFile);
  const fileAttachments = attachments.filter((attachment) => !isImageFile(attachment));
  useEffect(() => { if (!streaming) setReasoningOpen(false); }, [streaming]);

  return (
    <div className={`chat-message ${role}`}>
      <div className="message-avatar">{role === 'assistant' ? 'AI' : 'U'}</div>
      <div className="message-body">
        {showReasoningPanel && (
          <div className="reasoning-panel">
            <button
              type="button"
              className="reasoning-toggle"
              onClick={() => hasReasoningDetails && setReasoningOpen((open) => !open)}
              aria-expanded={hasReasoningDetails ? reasoningOpen : undefined}
              disabled={!hasReasoningDetails}
            >
              {streaming && <span className="spinner" />}
              <span>{streaming ? (status || '正在思考…') : `思考了 ${durationSeconds ?? 0}s`}</span>
              {hasReasoningDetails && <span>{reasoningOpen ? '⌃' : '⌄'}</span>}
            </button>
            {reasoningOpen && hasReasoningDetails && <div className="reasoning-content">{normalizedReasoning}</div>}
          </div>
        )}

        {role === 'assistant' ? (
          <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{sanitizeCitations(content)}</ReactMarkdown></div>
        ) : <div className="user-content">{content}</div>}

        {publicImages.map((url, index) => <img key={url} src={url} alt={`生成图片 ${index + 1}`} className="message-image" loading="lazy" decoding="async" />)}
        {images.length > 0 && <div className={`message-image-grid ${images.length === 1 ? 'single' : ''}`}>
          {images.map((image) => (
            <AuthenticatedImage
              key={image.file_id}
              image={image}
              selected={selectedImageID === image.file_id}
              editing={editingImageID === image.file_id}
              onUse={onUseImage ? () => onUseImage(image) : undefined}
              onSelect={onSelectImage && image.candidate_group_message_id && image.message_id ? () => onSelectImage(image) : undefined}
            />
          ))}
        </div>}

        {imageAttachments.length > 0 && <div className={`message-image-grid attachment-image-grid ${imageAttachments.length === 1 ? 'single' : ''}`}>
          {imageAttachments.map((attachment) => <AuthenticatedImage key={attachment.file_id} image={attachment} selected={false} />)}
        </div>}
        {fileAttachments.length > 0 && <div className="message-attachments">{fileAttachments.map((attachment) => {
          const extension = attachment.file_name.split('.').pop()?.slice(0, 5).toUpperCase() || 'FILE';
          const details = [extension, formatFileSize(attachment.size_bytes)].filter(Boolean).join(' · ');
          return (
            <button key={attachment.file_id} type="button" className="message-file-card" onClick={() => void chat.downloadFile(attachment)}>
              <span className="message-file-icon">{extension}</span>
              <span className="message-file-info"><strong>{attachment.file_name}</strong><small>{details}</small></span>
              <span className="message-file-download" aria-hidden="true">↓</span>
            </button>
          );
        })}</div>}

        {streaming && content && <span className="streaming-cursor" />}

        {role === 'assistant' && !streaming && (content || images.length > 0) && (
          <div className="message-actions">
            {content && <button type="button" onClick={() => void navigator.clipboard.writeText(content)} title="复制">▢</button>}
            {onRetry && <button type="button" onClick={onRetry} title="重试">↻</button>}
            {sources.length > 0 && <button type="button" onClick={() => setSourcesOpen((open) => !open)}>{sources.length} 个来源</button>}
          </div>
        )}
        {sourcesOpen && <div className="sources-panel" id="sources">{sources.map((source, index) => (
          <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><span>{index + 1}</span><div><strong>{source.title}</strong><small>{source.domain || source.url}</small></div></a>
        ))}</div>}
      </div>
    </div>
  );
}
