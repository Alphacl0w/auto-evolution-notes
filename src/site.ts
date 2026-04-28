export const SITE = {
  name: 'Memory Systems Notes',
  tagline: 'AI 记忆系统研究与工程笔记',
  description:
    '面向中文技术读者的 AI 记忆系统研究笔记，关注论文、开源实现、架构取舍、评测方法和工程优化。',
  author: 'Memory Systems Notes',
  locale: 'zh-CN',
  url: import.meta.env.PUBLIC_SITE_URL || 'https://agent-lab.top',
  github: 'https://github.com/Alphacl0w/auto-evolution-notes',
  email: 'hello@example.com',
};

export const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/articles/', label: '文章' },
  { href: '/categories/', label: '分类' },
  { href: '/tags/', label: '标签' },
  { href: '/about/', label: '关于' },
];
