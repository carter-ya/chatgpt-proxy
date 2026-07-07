export function getAvatarLetter(email?: string): string {
  if (!email) return '?';
  for (const ch of email) {
    if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  }
  return '?';
}

export function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (y === now.getFullYear()) return `${m}-${d}`;
  return `${y}-${m}-${d}`;
}

export function extractImages(
  content: string,
): string[] {
  const urls: string[] = [];
  // Match markdown images
  const mdRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(content)) !== null) {
    urls.push(match[1]);
  }
  // Match raw image URLs from known CDN
  const urlRegex = /https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?|https?:\/\/files\.oaiusercontent\.com\/[^\s"'<>]+/gi;
  while ((match = urlRegex.exec(content)) !== null) {
    if (!urls.includes(match[0])) {
      urls.push(match[0]);
    }
  }
  return urls;
}
