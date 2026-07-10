import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';
import { extractImages } from '../utils/format';
import { chat, type FileAsset } from '../api/client';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  streaming?: boolean;
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const codeStr = String(children).replace(/\n$/, '');

    if (match) {
      return (
        <SyntaxHighlighter
          style={dracula}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: 8 }}
        >
          {codeStr}
        </SyntaxHighlighter>
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

function AuthenticatedImage({ image }: { image: FileAsset }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    let objectURL = '';
    let cancelled = false;
    chat.getFileBlob(image)
      .then((blob) => {
        if (cancelled) return;
        objectURL = URL.createObjectURL(blob);
        setSrc(objectURL);
      })
      .catch(() => setSrc(''));
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [image]);

  return (
    <div className="message-image-container">
      {src && <img src={src} alt={image.file_name} className="message-image" />}
      <button type="button" onClick={() => void chat.downloadFile(image)}>
        下载图片
      </button>
    </div>
  );
}

export default function ChatMessage({
  role,
  content,
  images = [],
  attachments = [],
  streaming,
}: ChatMessageProps) {
  const publicImages = role === 'assistant' ? extractImages(content) : [];

  return (
    <div className={`chat-message ${role}`}>
      <div className="message-avatar">
        {role === 'assistant' ? 'AI' : 'U'}
      </div>

      <div className="message-body">
        {role === 'assistant' ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div>{content}</div>
        )}

        {publicImages.length > 0 &&
          publicImages.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`生成图片 ${i + 1}`}
              className="message-image"
            />
          ))}

        {images.map((image) => (
          <AuthenticatedImage key={image.file_id} image={image} />
        ))}

        {attachments.map((attachment) => (
          <button
            key={attachment.file_id}
            type="button"
            className="message-attachment"
            onClick={() => void chat.downloadFile(attachment)}
          >
            下载 {attachment.file_name}
          </button>
        ))}

        {streaming && <span className="streaming-cursor" />}
      </div>
    </div>
  );
}
