<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
const props = defineProps({ src: String, alt: String, crop: { type: Array, default: () => [0,0,0,0] }, pins: { type: Array, default: () => [] }, label: String })
const expanded = ref(false)
const ratio = computed(() => `${3840 * (1 - props.crop[0] - props.crop[2])} / ${2160 * (1 - props.crop[1] - props.crop[3])}`)
const imageStyle = computed(() => ({ width: `${100 / (1-props.crop[0]-props.crop[2])}%`, left: `${-100*props.crop[0]/(1-props.crop[0]-props.crop[2])}%`, top: `${-100*props.crop[1]/(1-props.crop[1]-props.crop[3])}%` }))
const url = computed(() => `${import.meta.env.BASE_URL}screens/${props.src}`)
function close(e) { if(e.key === 'Escape') expanded.value = false }
onMounted(() => window.addEventListener('keydown', close))
onBeforeUnmount(() => window.removeEventListener('keydown', close))
</script>
<template>
  <div class="shot-wrap">
    <button class="product-shot" :aria-label="`放大实页截图：${alt}`" :style="{ aspectRatio: ratio }" @click="expanded=true">
      <img :src="url" :alt="alt" :style="imageStyle" draggable="false" />
      <span v-for="(pin,i) in pins" :key="i" class="shot-pin" :style="{left: pin[0]+'%',top: pin[1]+'%'}">{{ i+1 }}</span>
      <span class="zoom-hint">查看高清 ↗</span>
    </button>
    <div v-if="label" class="shot-caption">{{ label }}</div>
    <Teleport to="body">
      <div v-if="expanded" class="shot-lightbox" role="dialog" aria-modal="true" :aria-label="alt" @click.self="expanded=false">
        <button class="lightbox-close" @click="expanded=false" autofocus>关闭 <kbd>Esc</kbd></button>
        <img :src="url" :alt="alt" />
        <span class="lightbox-caption">{{ alt }} · 原始 3840 × 2160 PNG</span>
      </div>
    </Teleport>
  </div>
</template>
