import { expect, test, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function authenticate(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('user', JSON.stringify({ id: 'user-e2e', email: 'e2e@example.com' }));
  });
}

async function mockModels(page: Page) {
  await page.route('**/api/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [
      { label: '5.5 极速', model: 'gpt-5-5-instant' },
      { label: '5.6 高', model: 'gpt-5-6-thinking', thinking_effort: 'extended' },
    ] }),
  }));
}

async function mockEmptyConversations(page: Page) {
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"items":[],"total":0}',
  }));
}

test('模型选择按账号持久化并在聊天与图片页共享', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);

  await page.goto('/chat');
  const modelSelect = page.getByRole('combobox', { name: '选择模型' });
  await modelSelect.selectOption('gpt-5-6-thinking|extended');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('gpt-5-6-thinking|extended');

  await page.reload();
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-5-6-thinking|extended');
  await page.goto('/images');
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-5-6-thinking|extended');
});

test('已保存模型失效时回退到接口默认模型的 standard 档', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    localStorage.setItem('chatgpt-proxy:model-preference:v1:user-e2e', 'removed-model|max');
  });
  await mockEmptyConversations(page);
  await page.route('**/api/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_model: 'gpt-new', options: [
      { label: '新模型 深入', model: 'gpt-new', thinking_effort: 'extended' },
      { label: '新模型 标准', model: 'gpt-new', thinking_effort: 'standard' },
    ] }),
  }));

  await page.goto('/chat');
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-new|standard');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('gpt-new|standard');
});

test('模型接口临时失败时不清除已保存偏好', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    localStorage.setItem('chatgpt-proxy:model-preference:v1:user-e2e', 'saved-model|standard');
  });
  await mockEmptyConversations(page);
  await page.route('**/api/models', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"temporarily unavailable"}',
  }));

  await page.goto('/chat');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('saved-model|standard');
});

test('历史消息清理引用、折叠思考并支持原地重试', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'c1', title: '黄金', model: 'gpt-5-6-thinking', updated_at: 'invalid-date', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/c1', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'c1', title: '黄金', model: 'gpt-5-6-thinking' },
      messages: [
        { id: 'u1', role: 'user', content: '黄金价格' },
        { id: 'a1', role: 'assistant', content: '当前价格 citeturn0search0', reasoning: '已核实多个来源', sources: [{ id: 's1', title: '示例来源', url: 'https://example.com', domain: 'example.com' }] },
      ],
    }),
  }));
  let retryBody: Record<string, unknown> = {};
  await page.route('**/api/conversations/c1/retry', async (route) => {
    retryBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"重新生成的回答","message_id":"a2"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat/c1');
  await expect(page.locator('body')).not.toContainText('NaN');
  await expect(page.locator('body')).not.toContainText('turn0search0');
  await page.getByRole('button', { name: /思考了/ }).click();
  await expect(page.getByText('已核实多个来源')).toBeVisible();
  await page.getByRole('button', { name: '1 个来源' }).click();
  await expect(page.getByRole('link', { name: /示例来源/ })).toBeVisible();
  await page.getByTitle('重试').click();
  await expect(page.getByText('重新生成的回答')).toBeVisible();
  expect(retryBody).toMatchObject({ assistant_message_id: 'a1' });
});

test('图片组与无语言代码块使用富组件渲染', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await authenticate(page);
  await mockModels(page);
  const marker = 'image_group{"aspect_ratio":"16:9","query":["water cycle"]}';
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'rich', title: '雨的形成过程', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/rich', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'rich', title: '雨的形成过程', model: 'gpt-5-6-thinking' },
      messages: [{
        id: 'answer', role: 'assistant', content: `${marker}\n\n雨的形成过程：\n\n\`\`\`\n面积：1,000,000 平方米\n水量 = 10,000 立方米\n\`\`\``,
        image_groups: [{ matched_text: marker, aspect_ratio: '16:9', images: [
          { thumbnail_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', content_url: 'https://images.openai.com/full', title: '水循环图' },
        ] }],
      }],
    }),
  }));

  await page.goto('/chat/rich');
  await expect(page.getByAltText('水循环图')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('image_group');
  await expect(page.locator('.code-block')).toContainText('面积：1,000,000 平方米');
  await page.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('水量 = 10,000 立方米');
  const copyMessage = page.getByRole('button', { name: '复制消息' });
  await expect(copyMessage.locator('svg')).toBeVisible();
  await expect(page.locator('.message-actions')).not.toContainText('▢');
  await copyMessage.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('雨的形成过程');
});

test('助手生成文件链接通过鉴权接口下载且不跳转聊天页面', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'files', title: '演示文稿', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/files', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'files', title: '演示文稿', model: 'gpt-5-6-thinking' },
      messages: [{
        id: 'assistant-file', role: 'assistant',
        content: '[下载演示文稿](sandbox:/mnt/data/水循环演示.pptx)\n\n[失败文件](sandbox:/mnt/data/missing.zip)\n\n[官方网站](https://example.com)',
      }],
    }),
  }));

  let downloadURL = '';
  let authorization = '';
  let releaseDownload: (() => void) | undefined;
  await page.route(/\/api\/conversations\/files\/files\/download\?.+/, async (route) => {
    const requestURL = new URL(route.request().url());
    if (requestURL.searchParams.get('sandbox_path')?.endsWith('missing.zip')) {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"missing"}' });
      return;
    }
    downloadURL = route.request().url();
    authorization = route.request().headers().authorization || '';
    await new Promise<void>((resolve) => { releaseDownload = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx" },
      body: 'ppt-content',
    });
  });

  await page.goto('/chat/files');
  const initialURL = page.url();
  const downloadLink = page.getByRole('link', { name: '下载演示文稿' });
  await expect(downloadLink).toHaveAttribute('href', 'sandbox:/mnt/data/%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx');
  await downloadLink.click();
  await expect(downloadLink).toContainText('下载中');
  releaseDownload?.();
  await expect.poll(() => downloadURL).toContain('/api/conversations/files/files/download?');
  const requested = new URL(downloadURL);
  expect(requested.searchParams.get('message_id')).toBe('assistant-file');
  expect(requested.searchParams.get('sandbox_path')).toBe('sandbox:/mnt/data/%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx');
  expect(authorization).toBe('Bearer e2e-token');
  await expect.poll(() => page.url()).toBe(initialURL);

  await page.getByRole('link', { name: '失败文件' }).click();
  await expect(page.getByText('（下载失败，点击重试）')).toBeVisible();
  await expect(page.getByRole('link', { name: '官方网站' })).toHaveAttribute('href', 'https://example.com');
});

test('新会话流式返回的文件链接使用上游会话和消息 ID 下载', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  const content = '[下载表格](sandbox:/mnt/data/result.xlsx)';
  await page.route('**/api/conversation', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: [
      `data: ${JSON.stringify({ conversation_id: 'stream-created' })}\n\n`,
      `data: ${JSON.stringify({ content, message_id: 'assistant-stream' })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
  }));
  await page.route('**/api/conversations/stream-created', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'stream-created', title: '表格', model: 'gpt-5-6-thinking' },
      messages: [{ id: 'assistant-stream', role: 'assistant', content }],
    }),
  }));
  let messageId = '';
  let sandboxPath = '';
  await page.route(/\/api\/conversations\/stream-created\/files\/download\?.+/, async (route) => {
    const requestURL = new URL(route.request().url());
    messageId = requestURL.searchParams.get('message_id') || '';
    sandboxPath = requestURL.searchParams.get('sandbox_path') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="result.xlsx"' },
      body: 'xlsx-content',
    });
  });

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('生成一个表格');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page).toHaveURL(/\/chat\/stream-created$/);
  await page.getByRole('link', { name: '下载表格' }).click();
  await expect.poll(() => messageId).toBe('assistant-stream');
  expect(sandboxPath).toBe('sandbox:/mnt/data/result.xlsx');
});

test('新会话先显示临时标题再替换为上游标题', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  let conversationSent = false;
  await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
    if (!conversationSent) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'created', title: '雨的形成过程', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
    });
  });
  await page.route('**/api/conversation', async (route) => {
    conversationSent = true;
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: 'data: {"conversation_id":"created"}\n\ndata: {"content":"回答"}\n\ndata: [DONE]\n\n',
    });
  });
  await page.route('**/api/conversations/created', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'created', title: '雨的形成过程', model: 'gpt-5-6-thinking' }, messages: [{ id: 'answer', role: 'assistant', content: '回答' }] }),
  }));

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('请解释雨是怎么形成的');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.conversation-item')).toContainText('请解释雨是怎么形成的');
  await expect(page.locator('.conversation-item')).toContainText('雨的形成过程');
});

test('输入框支持多文件上传、任意格式和图片预览', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/conversations/c-new', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'c-new', title: '文件', model: 'gpt-5-6-thinking' }, messages: [{ id: 'u-new', role: 'user', content: '分析这些文件', attachments: [
      { file_id: 'upload-1', file_name: 'preview.png', mime_type: 'image/png', size_bytes: 4, width: 1, height: 1, download_url: '/api/files/upload-1/download' },
      { file_id: 'upload-2', file_name: 'archive.xyz', mime_type: 'application/x-custom', size_bytes: 2048, width: 0, height: 0, download_url: '/api/files/upload-2/download' },
    ] }, { id: 'a-new', role: 'assistant', content: '收到文件' }] }),
  }));
  await page.route('**/api/files/upload-1/download', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  let uploadIndex = 0;
  await page.route('**/api/files', async (route) => {
    uploadIndex += 1;
    const image = uploadIndex === 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ file_id: `upload-${uploadIndex}`, file_name: image ? 'preview.png' : 'archive.xyz', mime_type: image ? 'image/png' : 'application/x-custom', size_bytes: 4, width: image ? 1 : 0, height: image ? 1 : 0, download_url: `/api/files/upload-${uploadIndex}/download` }),
    });
  });
  let conversationBody: Record<string, unknown> = {};
  await page.route('**/api/conversation', async (route) => {
    conversationBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"conversation_id":"c-new"}\n\ndata: {"content":"收到文件"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat');
  const input = page.locator('input[type=file]');
  await expect(input).toHaveAttribute('multiple', '');
  await expect(input).not.toHaveAttribute('accept', /.+/);
  await input.setInputFiles([
    { name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3, 4]) },
    { name: 'archive.xyz', mimeType: 'application/x-custom', buffer: Buffer.from([5, 6, 7, 8]) },
  ]);
  await expect(page.getByAltText('preview.png')).toBeVisible();
  await expect(page.getByText('archive.xyz')).toBeVisible();
  await page.getByPlaceholder('输入消息...').fill('分析这些文件');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('收到文件')).toBeVisible();
  await expect(page.locator('.chat-message.user img[alt="preview.png"]')).toBeVisible();
  await expect(page.locator('.chat-message.user .message-file-card')).toContainText('archive.xyz');
  await expect(page.locator('.chat-message.user .message-file-card')).toContainText('2.0 KB');
  expect(conversationBody.attachments).toHaveLength(2);
});

test('生成过程中只显示一个思考状态块', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  let releaseResponse: (() => void) | undefined;
  await page.route('**/api/conversation', async (route) => {
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"完成"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('测试思考状态');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('正在思考…', { exact: true })).toHaveCount(1);
  await expect(page.locator('.reasoning-panel')).toHaveCount(1);
  await expect(page.locator('.assistant-working')).toHaveCount(0);
  releaseResponse?.();
  await expect(page.getByText('完成', { exact: true })).toBeVisible();
});

test('移动端点击图片导航后自动关闭侧栏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'c1', title: '测试会话', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));

  await page.goto('/chat');
  await page.getByRole('button', { name: '切换侧边栏' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);
  await page.getByRole('button', { name: '图片', exact: true }).click();

  await expect(page).toHaveURL(/\/images$/);
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('.sidebar-overlay')).not.toHaveClass(/open/);
});
