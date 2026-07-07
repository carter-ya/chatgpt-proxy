import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react';
import { chat } from '../api/client';

interface ChatInputProps {
  onSend: (text: string, model: string, genId?: string) => void;
  sending: boolean;
  onCancel: () => void;
}

export default function ChatInput({ onSend, sending, onCancel }: ChatInputProps) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [genId, setGenId] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed, 'gpt-4o', genId);
    setText('');
    setGenId(undefined);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, sending, genId, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('文件大小不能超过 10MB');
      return;
    }

    if (!file.type.startsWith('image/')) {
      alert('仅支持图片文件');
      return;
    }

    setUploading(true);
    try {
      const result = await chat.uploadFile(file);
      setGenId(result.file_id);
    } catch {
      alert('图片上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  return (
    <>
      {genId && (
        <div className="file-preview">
          <span className="file-preview-item">
            📎 已附加图片
            <button
              className="remove-file"
              onClick={() => setGenId(undefined)}
              aria-label="移除图片"
            >
              ×
            </button>
          </span>
        </div>
      )}

      <div className="chat-input-container">
        <div className="chat-input-wrapper">
          {sending ? (
            <button className="send-btn" onClick={onCancel} aria-label="停止生成">
              ⏹
            </button>
          ) : (
            <button
              className="upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="上传图片"
            >
              {uploading ? <span className="spinner" /> : '📎'}
            </button>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            disabled={sending}
            rows={1}
          />

          <button
            className="send-btn"
            onClick={handleSend}
            disabled={sending || !text.trim()}
            aria-label="发送"
          >
            {sending ? <span className="spinner" /> : '➤'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
        </div>
      </div>
    </>
  );
}
