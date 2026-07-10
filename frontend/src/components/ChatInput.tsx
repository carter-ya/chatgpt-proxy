import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react';
import { chat, type UploadedFile } from '../api/client';

interface ChatInputProps {
  onSend: (text: string, model: string, genId?: string, attachment?: UploadedFile) => void;
  sending: boolean;
  onCancel: () => void;
}

export default function ChatInput({ onSend, sending, onCancel }: ChatInputProps) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [genId] = useState<string | undefined>(undefined);
  const [attachment, setAttachment] = useState<UploadedFile | undefined>(undefined);
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
    onSend(trimmed, 'gpt-5-6-thinking', genId, attachment);
    setText('');
    setAttachment(undefined);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, sending, genId, attachment, onSend]);

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

    if (file.size > 50 * 1024 * 1024) {
      alert('文件大小不能超过 50MB');
      return;
    }

    setUploading(true);
    try {
      const result = await chat.uploadFile(file);
      setAttachment(result);
    } catch {
      alert('文件上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDownloadAttachment = useCallback(() => {
    if (attachment) void chat.downloadFile(attachment);
  }, [attachment]);

  return (
    <>
      {attachment && (
        <div className="file-preview">
          <span className="file-preview-item">
            📎 {attachment.file_name}
            <button type="button" className="download-file" onClick={handleDownloadAttachment}>
              下载
            </button>
            <button
              className="remove-file"
              onClick={() => setAttachment(undefined)}
              aria-label="移除文件"
            >
              ×
            </button>
          </span>
        </div>
      )}

      <div className="chat-input-container">
        <div className="chat-input-wrapper">
          {sending && (
            <button className="send-btn" onClick={onCancel} aria-label="停止生成">
              ⏹
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

          {!sending && (
            <button
              className="upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="上传文件"
            >
              {uploading ? <span className="spinner" /> : '📎'}
            </button>
          )}

          <button
            className="send-btn"
            onClick={handleSend}
            aria-disabled={sending || !text.trim()}
            tabIndex={0}
            aria-label="发送"
          >
            {sending ? <span className="spinner" /> : '➤'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.html"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
        </div>
      </div>
    </>
  );
}
