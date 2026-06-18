import { defineConfig } from 'vitepress';
import packageJson from "../../../package.json" with { type: "json" };

const repo = 'https://github.com/jd-solanki/krutrimbox'

export default defineConfig({
  title: 'Krutrimbox',
  description:
    'A local orchestrator that turns agent-ready GitHub issues into coordinated agent work, human handoffs, and final review routing.',
  lastUpdated: true,
  cleanUrls: true,

  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/guide/' },
      {
        text: `v${packageJson.version}`,
        items: [
          { text: 'npm', link: 'https://www.npmjs.com/package/krutrimbox' },
          { text: 'Changelog', link: `${repo}/releases` },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Why krutrimbox', link: '/guide/why' },
        ],
      },
      {
        text: 'Setup',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Network Policy', link: '/guide/network-policy' },
          { text: 'Sandbox Template', link: '/guide/sandbox-template' },
        ],
      },
      {
        text: 'Usage',
        items: [
          { text: 'Running krutrimbox', link: '/guide/running' },
          { text: 'Team Workflows', link: '/guide/team-workflows' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Factory Flow', link: '/guide/concepts/factory-flow' },
          { text: 'Issue Ownership & Routing', link: '/guide/concepts/issue-ownership-and-routing' },
          { text: 'Capabilities & Limitations', link: '/guide/concepts/capabilities' },
        ],
      },
      {
        text: 'Advanced',
        items: [
          { text: 'SSH Remotes', link: '/guide/advanced/ssh' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/vitepress/:path`,
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    footer: {
      message: 'A code factory for agent-ready GitHub issues.',
      copyright: 'Copyright © 2026 JD Solanki',
    },
  },
})
