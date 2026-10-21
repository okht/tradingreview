<script setup>
import { computed, ref, useId } from 'vue'
import ProductShot from './ProductShot.vue'

const sources = [
  {
    id: 'api',
    label: '只读 API',
    title: '让成交记录进入复盘',
    src: 'import-readonly-api-entry.png',
    alt: '只读成交 API 配置入口的真实页面',
    crop: [0.125, 0.099, 0.125, 0.098],
    notes: [
      ['连接只读成交接口', '输入接口地址与访问凭证。'],
      ['核对后再纳入复盘', '统一整理标的、时间与成交。'],
    ],
    status: '配置入口已具备；账户联调待验证。',
  },
  {
    id: 'fuyao',
    label: '扶摇',
    title: '补充行情与相关材料',
    src: 'settings-fuyao-data-source.png',
    alt: '扶摇数据源配置的真实页面',
    crop: [0.258, 0.051, 0.258, 0.051],
    notes: [
      ['连接行情与资讯来源', '为逐笔复盘补充可核对的材料。'],
      ['保留明确的数据口径', '历史日 K 使用未复权口径。'],
    ],
    status: '服务端已配置；可用能力待验证。',
  },
  {
    id: 'ifind',
    label: 'iFinD',
    title: '按权限接入金融数据',
    src: 'settings-ifind-empty-config.png',
    alt: 'iFinD 官方 MCP 空配置的真实页面',
    crop: [0.258, 0.26, 0.258, 0.051],
    notes: [
      ['配置官方 MCP 服务', '使用用户自己的数据权限。'],
      ['按复盘需要补充证据', '保留来源与时间，方便核对。'],
    ],
    status: '当前为空配置；尚未完成接口联调。',
  },
]

const selected = ref(0)
const source = computed(() => sources[selected.value])
const instanceId = useId()
const panelId = `${instanceId}-source-panel`
const shotWidth = computed(() => {
  const [left, top, right, bottom] = source.value.crop
  const ratio = (3840 * (1 - left - right)) / (2160 * (1 - top - bottom))
  return `${Math.min(650, 420 * ratio)}px`
})

function changeWithKeyboard(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Home') selected.value = 0
  else if (event.key === 'End') selected.value = sources.length - 1
  else selected.value = (selected.value + (event.key === 'ArrowRight' ? 1 : -1) + sources.length) % sources.length
  event.currentTarget.querySelectorAll('[role="tab"]')[selected.value]?.focus()
}
</script>

<template>
  <section class="source-demo" aria-label="数据接入方式演示">
    <div class="source-copy">
      <div class="source-tabs" role="tablist" aria-label="选择数据来源" @keydown="changeWithKeyboard">
        <button
          v-for="(item, index) in sources"
          :id="`${instanceId}-${item.id}`"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="selected === index"
          :aria-controls="panelId"
          :tabindex="selected === index ? 0 : -1"
          :class="{ selected: selected === index }"
          @click.stop="selected = index"
        >{{ item.label }}</button>
      </div>

      <h3 class="source-title">{{ source.title }}</h3>
      <ol class="source-notes">
        <li v-for="(note, index) in source.notes" :key="`${source.id}-${index}`">
          <span class="source-number">{{ String(index + 1).padStart(2, '0') }}</span>
          <div><h4>{{ note[0] }}</h4><p>{{ note[1] }}</p></div>
        </li>
      </ol>
      <p class="source-status"><span aria-hidden="true"></span>{{ source.status }}</p>
    </div>

    <div
      :id="panelId"
      class="source-screen"
      role="tabpanel"
      :aria-labelledby="`${instanceId}-${source.id}`"
    >
      <ProductShot
        :key="source.id"
        :src="source.src"
        :alt="source.alt"
        :crop="source.crop"
        :style="{ width: shotWidth, maxWidth: '100%' }"
      />
    </div>
  </section>
</template>

<style scoped>
.source-demo {
  width: 1164px;
  max-width: 100%;
  height: 450px;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 64px;
  align-items: center;
  color: #000;
}
.source-copy { width: 240px; align-self: start; padding-top: 15px; }
.source-tabs { display: flex; gap: 5px; margin-bottom: 30px; }
.source-tabs button {
  border: 1px solid #dedede;
  border-radius: 999px;
  padding: 8px 13px;
  color: #383838;
  background: #fff;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .15s, color .15s;
}
.source-tabs button.selected { background: #000; color: #fff; border-color: #000; }
.source-tabs button:focus-visible { outline: 3px solid #bcff2f; outline-offset: 3px; }
.source-title { margin: 0 0 25px; font-size: 21px; font-weight: 700; line-height: 1.5; }
.source-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 25px; }
.source-notes li { display: grid; grid-template-columns: 23px 1fr; gap: 10px; }
.source-number { padding-top: 3px; font-size: 11px; font-weight: 700; color: #777; }
.source-notes h4 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.5; }
.source-notes p { margin: 6px 0 0; font-size: 13px; line-height: 1.75; color: #5b5b5b; }
.source-status {
  margin: 31px 0 0;
  padding-top: 15px;
  border-top: 1px solid #e6e6e6;
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: #777;
  font-size: 11px;
  line-height: 1.75;
}
.source-status > span { width: 5px; height: 5px; background: #999; flex: 0 0 5px; }
.source-screen { min-width: 0; height: 450px; display: flex; align-items: center; justify-content: center; }
.source-screen :deep(.product-shot) { max-height: 420px; }
</style>
