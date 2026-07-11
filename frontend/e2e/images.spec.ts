import { expect, test, type Page } from '@playwright/test';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function image(fileId: string, generationId: string) {
  return {
    file_id: fileId,
    file_name: `${fileId}.png`,
    mime_type: 'image/png',
    size_bytes: png.length,
    width: 1024,
    height: 1024,
    download_url: `/api/files/${fileId}/download`,
    generation_id: generationId,
  };
}

async function authenticate(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('user', JSON.stringify({ email: 'e2e@example.com' }));
  });
}

test('生成候选图、选择候选并引用原图继续编辑', async ({ page }) => {
  await authenticate(page);

  const generationRequests: Array<Record<string, unknown>> = [];
  let selectionRequests = 0;
  let selectionBody: Record<string, unknown> = {};
  await page.route('**/api/conversations*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 }),
    }),
  );
  await page.route('**/api/files/*/download', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: png }),
  );
  await page.route('**/api/images/select', async (route) => {
    selectionRequests += 1;
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/images/generations', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    generationRequests.push(body);
    const images = generationRequests.length === 1
      ? [image('file-one', 'gen-one'), image('file-two', 'gen-two')]
      : [image('file-edited', 'gen-edited')];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: {"conversation_id":"conversation-1"}\n\ndata: ${JSON.stringify({ images })}\n\ndata: [DONE]\n\n`,
    });
  });

  await page.goto('/images');
  await page.getByPlaceholder('描述你想生成的图片...').fill('生成两张测试图片');
  await page.getByRole('button', { name: '生成图片' }).click();

  await expect(page.getByText('请选择你更满意的图片')).toBeVisible();
  await expect(page.locator('.generated-image-option')).toHaveCount(2);
  await page.getByRole('button', { name: '选择第 2 张', exact: true }).click();
  await expect(page.getByRole('button', { name: '已选择', exact: true })).toBeVisible();
  await expect(page.getByText(/正在编辑/)).toHaveCount(0);
  expect(selectionRequests).toBe(1);
  expect(selectionBody).toEqual({ conversation_id: 'conversation-1', file_id: 'file-two' });

  await page.locator('.generated-image-option').nth(1).click();
  await expect(page.getByText('正在编辑：file-two.png')).toBeVisible();
  await page.getByPlaceholder('描述你想生成的图片...').fill('把背景改成森林');
  await page.getByRole('button', { name: '生成图片' }).click();
  await expect(page.getByAltText('file-edited.png')).toBeVisible();

  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[0]).toMatchObject({ prompt: '生成两张测试图片' });
  expect(generationRequests[1]).toMatchObject({
    prompt: '把背景改成森林',
    conversation_id: 'conversation-1',
    original_gen_id: 'gen-two',
    original_file_id: 'file-two',
  });
});
