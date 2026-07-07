import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

const apiClient = axios.create({
  baseURL: API_BASE,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export interface LoginResponse {
  token: string;
  user: { email: string };
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
}

export const auth = {
  register: (email: string, password: string) =>
    apiClient.post<LoginResponse>('/auth/register', { email, password }),
  login: (email: string, password: string) =>
    apiClient.post<LoginResponse>('/auth/login', { email, password }),
};

export const chat = {
  sendMessage: (
    message: string,
    model: string,
    conversationId?: string,
    stream = true,
    genId?: string,
    attachmentFileId?: string,
  ) => {
    return fetch(`${API_BASE}/conversation`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        message,
        model,
        conversation_id: conversationId,
        stream,
        gen_id: genId,
        attachment_file_id: attachmentFileId,
      }),
    });
  },

  uploadFile: async (file: File): Promise<{ file_id: string; url: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<{ file_id: string; url: string }>('/files', formData);
    return res.data;
  },

  listConversations: () =>
    apiClient.get<Conversation[]>('/conversations'),

  getConversation: (id: string) =>
    apiClient.get<{ conversation: Conversation; messages: Message[] }>(
      `/conversations/${id}`,
    ),

  updateConversation: (id: string, data: Record<string, unknown>) =>
    apiClient.patch(`/conversations/${id}`, data),
};

export default apiClient;
