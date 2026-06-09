/** 章节图标映射 */
const SECTION_ICONS: Record<string, string> = {
  '画面概览': '🌙',
  '关键象征': '🔑',
  '情绪与主题': '💫',
  '自我探索': '🔍',
};

/** HTML 实体转义，防止 XSS */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 将 **xxx** 解析为 <strong>，先转义再插入标签 */
function inlineBold(text: string): string {
  // 文本已经过 escapeHtml，但 ** 不含需要转义的字符，可直接处理
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** 增强 Markdown 渲染，带语义化类名和章节图标，跳过 # 梦境之名 */
export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  let html = '';
  let inList = false;
  let listIndex = 0;
  let skippedTitle = false;

  for (const line of lines) {
    const t = line.trim();
    // 跳过 # 梦境之名 标题行及其下一行标题内容（标题由外部 h3 展示）
    if (!skippedTitle && /^#\s*梦境之名/.test(t)) {
      skippedTitle = true;
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    if (skippedTitle) {
      // 跳过标题内容行（紧跟在 # 梦境之名 后的非空行）
      if (t && !/^##\s+/.test(t)) {
        skippedTitle = false;
        continue;
      }
      skippedTitle = false;
      // 如果是 ## 标题则继续处理
    }
    if (/^##\s+/.test(t)) {
      if (inList) { html += '</ul>'; inList = false; }
      const title = escapeHtml(t.replace(/^##\s+/, ''));
      const icon = SECTION_ICONS[t.replace(/^##\s+/, '')] || '✦';
      html += `<h4 class="interpSection"><span class="interpSectionIcon">${icon}</span>${title}</h4>`;
    } else if (/^[-*]\s+/.test(t)) {
      if (!inList) { html += '<ul class="interpList">'; inList = true; listIndex = 0; }
      listIndex++;
      html += `<li class="interpItem"><span class="interpBullet">${listIndex}</span>${inlineBold(escapeHtml(t.replace(/^[-*]\s+/, '')))}</li>`;
    } else if (t === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p class="interpPara">${inlineBold(escapeHtml(t))}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

/** 从解读文本中提取梦境标题 */
export function extractDreamTitle(md: string): string | null {
  const match = md.match(/^#\s*梦境之名\s*\n+(.+)/m);
  return match ? match[1].trim().replace(/^[-*]\s+/, '') : null;
}
