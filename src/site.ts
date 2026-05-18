export const SITE = {
  name: 'Memory Systems Notes',
  tagline: 'AI 记忆系统与安全工程研究',
  description:
    '面向中文技术读者的深度技术笔记，长期研究 AI 记忆系统与网络安全工程，关注论文、源码、架构方案、验证方法和工程取舍。',
  author: 'Memory Systems Notes',
  locale: 'zh-CN',
  url: import.meta.env.PUBLIC_SITE_URL || 'https://agent-lab.top',
  github: 'https://github.com/Alphacl0w/auto-evolution-notes',
  email: 'hello@example.com',
};

export const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/research/', label: '研究方向' },
  { href: '/articles/', label: '文章' },
  { href: '/categories/', label: '分类' },
  { href: '/tags/', label: '标签' },
  { href: '/about/', label: '关于' },
];

export const TRACKS = {
  'agent-memory': {
    id: 'agent-memory',
    label: 'Agent Memory',
    title: 'AI 记忆系统研究',
    description:
      '跟踪 Agent 长期记忆、上下文压缩、RAG、经验沉淀、遗忘策略、评测方法和生产化架构。',
  },
  security: {
    id: 'security',
    label: 'Security Engineering',
    title: '网络安全工程研究',
    description:
      '研究白盒扫描、代码图、静态分析、Agent 安全审计、漏洞验证、规则系统和安全自动化工程。',
  },
} as const;

export type TrackId = keyof typeof TRACKS;
