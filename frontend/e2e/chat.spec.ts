import { expect, test, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function authenticate(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('user', JSON.stringify({ email: 'e2e@example.com' }));
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
