<script setup>
defineProps({ number: String, section: String, title: String, subtitle: String, dark: Boolean })
</script>
<template>
  <section class="deck-page" :class="{ dark }">
    <div class="page-top"><span class="brand">TradingReview<span class="brand-dot"></span></span><span>{{ section }}</span></div>
    <header><h1>{{ title }}</h1><p v-if="subtitle" class="subtitle">{{ subtitle }}</p></header>
    <div class="page-content"><slot /></div>
    <footer><span>投资决策复盘与学习</span><span>{{ number }} <i>/</i> 18</span></footer>
  </section>
</template>
