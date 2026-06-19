<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ id: string; graph: string }>()

const { isDark } = useData()
const svg = ref('')

// Unicode-safe base64 decode of the graph definition passed by the markdown-it fence rule.
const definition = computed(() => {
  const binary = atob(props.graph)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
})

async function render() {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark.value ? 'dark' : 'default',
  })
  // Wait for web fonts before rendering: mermaid sizes nodes by measuring text,
  // and measuring with the fallback font clips lines once the real font loads.
  if (typeof document !== 'undefined' && document.fonts?.ready)
    await document.fonts.ready
  const { svg: rendered } = await mermaid.render(props.id, definition.value)
  svg.value = rendered
}

onMounted(render)
watch(isDark, render)
</script>

<template>
  <div class="mermaid" v-html="svg" />
</template>

<style scoped>
.mermaid {
  display: flex;
  justify-content: center;
  margin: 16px 0;
}
.mermaid :deep(svg) {
  max-width: 100%;
  height: auto;
}
/* VitePress's .vp-doc gives <p> a 1.75 line-height, but mermaid sized each
   label box for its own 1.5 line-height — the mismatch clips the last line. */
.mermaid :deep(foreignObject p) {
  line-height: 1.5;
  margin: 0;
}
</style>
