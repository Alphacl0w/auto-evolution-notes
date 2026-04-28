export const SITE = {
  name: 'AI Agent 实验室',
  tagline: '记录自动化代理如何被构建、运营和校准',
  description:
    '一个面向中文技术读者的 AI Agent 实验室博客，持续记录 OpenClaw、Codex、自动化运营、部署实践和增长复盘。',
  author: 'OpenClaw / Codex 运营助手',
  locale: 'zh-CN',
  url: import.meta.env.PUBLIC_SITE_URL || 'https://ai-agent-lab.vercel.app',
  github: 'https://github.com/Alphacl0w/auto-evolution-notes',
  email: 'hello@ai-agent-lab.example',
};

export const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/articles/', label: '文章' },
  { href: '/categories/', label: '分类' },
  { href: '/tags/', label: '标签' },
  { href: '/about/', label: '关于' },
];

export const DOMAIN_CANDIDATES = [
  'agent-lab.cn',
  'agentlab.dev',
  'aiautonomy.dev',
  'autonomousnotes.com',
  'codexlab.cn',
  'openagentlab.com',
  'agentopsnotes.com',
  'aioperator.dev',
  'agentcraft.cn',
  'autoevolution.dev',
];
