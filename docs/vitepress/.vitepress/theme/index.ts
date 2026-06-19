import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Mermaid from '../components/Mermaid.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Mermaid', Mermaid)
  },
} satisfies Theme
