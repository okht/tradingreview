<script setup>
import { ref } from 'vue'
const adopted = ref(false)
</script>
<template>
  <div class="suggestion-demo">
    <div class="demo-switch"><button :class="{selected: !adopted}" @click="adopted=false">灰字建议</button><button :class="{selected: adopted}" @click="adopted=true">按 Tab 后</button><span>实际操作的前后截图</span></div>
    <ProductShot :src="adopted ? 'gray-suggestion-adopted.png' : 'gray-suggestion.png'" :alt="adopted ? 'Tab 采纳后的真实输入框' : '输入框内的灰字预测建议'" :crop="[0.22,0.28,0.03,0.27]" />
  </div>
</template>
