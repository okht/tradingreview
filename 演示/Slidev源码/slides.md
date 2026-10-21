---
theme: default
title: TradingReview · 投资决策复盘与学习
titleTemplate: '%s'
info: |
  TradingReview 产品方案。真实界面截图、关键交互与测试说明。
  股票身份真实，演示行情、成交与用户行为为模拟。
author: TradingReview
layout: canvas
defaults:
  layout: canvas
transition: fade-out
aspectRatio: 16/9
canvasWidth: 1280
colorSchema: light
fonts:
  sans: Microsoft YaHei
  local: [Microsoft YaHei]
  provider: none
drawings:
  persist: false
mdc: true
download: false
selectable: true
---

<div class="cover">
  <div class="cover-top"><div class="brand">TradingReview<span class="brand-dot"></span></div></div>
  <div class="cover-copy"><div class="cover-line"></div><h1>从每笔交易<br>走向<em>下一次改进</em></h1><p>投资决策复盘与学习<br>还原背景，核对证据，检验方法。</p></div>
  <div class="hero-shot"><ProductShot src="hero-workspace.png" alt="浅灰底工作台中的15分钟行情" /></div>
</div>

<!--
今天展示一段交易如何进入复盘，怎样用AI减少补充背景的工作，最后把分析沉淀为可验证的方法和可执行的检查项。画面均为我们自行截取的真实产品页面。示例采用贵州茅台的真实股票身份，价格、成交与用户行为是合成演示数据。产品外层已按最新要求改为纯浅灰，左上角只保留头像。截图保留4K PNG原始像素，点击可查看完整原图。
-->

---

<DeckPage number="02" section="产品主线" title="复盘的终点，是下一次可执行的改进" subtitle="围绕同一段交易，把材料、判断和后续动作连在一起。">
  <div class="journey">
    <div><div class="step">01 / 输入</div><h3>导入交易</h3><p>文件与只读接口</p></div>
    <div><div class="step">02 / 还原</div><h3>背景与证据</h3><p>行为预测与时点核对</p></div>
    <div><div class="step">03 / 分析</div><h3>AI 复盘</h3><p>事实、解释与改进建议</p></div>
    <div><div class="step">04 / 检验</div><h3>方法与回测</h3><p>规则化与同条件对照</p></div>
    <div><div class="step">05 / 沉淀</div><h3>交易前检查项</h3><p>在下一次行动前使用</p></div>
  </div>
  <div class="overview-bottom"><ProductShot src="workspace.png" alt="真实复盘工作台" /><div><p class="overview-quote">既看清这次发生了什么，<br>也留下<span>下次怎么做</span>。</p><p class="note" style="margin-top:20px">材料和对话保留在工作台，方法与检查项持续积累。</p></div></div>
</DeckPage>

<!--
主线从交易进入产品开始。背景由用户补充，AI根据历史行为给建议并自动整理相关证据。复盘后提供方法改进与检查项两个出口，方法可以回测，检查项可人工编辑。当前主案例有20笔成交、两个保存的方法版本和一个保存的检查项。
-->

---

<DeckPage number="03" section="01 / 接入" title="用自己的 ChatGPT 订阅开始复盘" subtitle="订阅与 API 接入放在同一入口，延续用户已有的模型使用方式。">
  <div class="split narrow-shot" style="padding:0 35px 0 10px;align-items:center">
    <div class="copy-stack"><div><div class="num-label">01</div><h2>选择熟悉的模型</h2><p>在 ChatGPT 订阅和 API 之间切换，<br>模型用于后续分析与材料整理。</p></div><div><div class="num-label">02</div><h2>授权保存，继续工作</h2><p>重启后恢复已有授权，<br>减少重复连接和等待。</p></div><p class="note">截图为已保存授权状态。真实 AI 复盘结果见后续页面。</p></div>
    <div style="width:365px;justify-self:center"><ProductShot src="settings-chatgpt-subscription.png" alt="ChatGPT订阅设置入口" :crop="[.258,.088,.258,.088]" /></div>
  </div>
</DeckPage>

<!--
真实设置界面提供API接入和ChatGPT订阅。订阅凭证用Windows当前用户DPAPI加密持久化，并已验证服务重启恢复。截图显示授权已保存且可以验证模型，不能仅用此截图声称刚完成模型验证。真实复盘已使用gpt-6.1-sol跑通。凭证没有出现在演示素材中。
-->

---

<DeckPage number="04" section="01 / 接入" title="交易进入产品后，先看清再确认" subtitle="把不同来源的成交整理成统一记录，保留逐笔核对和修改的机会。">
  <div class="split wide-shot" style="grid-template-columns:660px 1fr;gap:70px">
    <ProductShot src="import-csv-preview-20-trades.png" alt="20笔成交CSV导入预览" :crop="[.125,.05,.125,.05]" />
    <div class="copy-stack"><div><h3><span class="note-index">1</span>保留来源</h3><p>文件与识别结果对应，<br>方便回到原始材料。</p></div><div><h3><span class="note-index">2</span>逐笔核对</h3><p>时间、方向、数量、价格、费用<br>使用同一套字段。</p></div><div><h3><span class="note-index">3</span>确认后进入复盘</h3><p>需要补齐的字段明确提示，<br>修改完成再继续。</p></div><p class="note">当前实测：CSV 与标准资料包。<br>产品方案面向多格式材料持续扩展。</p></div>
  </div>
</DeckPage>

<!--
这是实际CSV预览页，整理出20笔成交。为避免重复导入，补拍只进入预览；完整EQ01标准资料包导入此前已通过。多格式文件是预期产品方向，本轮验证范围是CSV与标准bundle，不将任意文件都称为已经兼容。
-->

---

<DeckPage number="05" section="01 / 接入" title="成交接口、行情与证据，共用数据入口" subtitle="按来源连接，围绕标的、成交时点与决策背景组织材料。">
  <DataSourceDemo />
</DeckPage>

<!--
本页标签可以切换三张真实配置截图。只读HTTP接口用于读取符合产品协议的成交，读到后仍需核对。交易所和链上专用适配是产品方案方向。扶摇服务端已配置，历史日K为未复权，实际能力仍按验证结果确定。iFinD展示官方HTTP MCP配置入口，本轮未完成新授权联调。分钟复盘不能直接拿完整日K替代。合成案例自动取证只核对资料包证据，真实公司新闻无法证明模拟动机。
-->

---

<DeckPage number="06" section="02 / 还原" title="回到成交当时，才看得清一次决策" subtitle="15 分钟观察交易节点，同时区分当时可知与后续结果。">
  <div style="width:860px;margin:0 auto"><ProductShot src="chart-15m.png" alt="第5笔交易的15分钟行情与时间视角" :crop="[.11,.084,.06,.295]" /></div>
  <div class="notes-strip"><div><h3><span class="note-index">1</span>逐笔定位</h3><p>交易时间与图上的买卖节点对应。</p></div><div><h3><span class="note-index">2</span>时点隔离</h3><p>当时可知与后续结果分别查看。</p></div><div><h3><span class="note-index">3</span>未收盘标记</h3><p>当前 K 线保留截至决策时点的状态。</p></div></div>
</DeckPage>

<!--
EQ01第5笔，2025-03-07 09:40买入200股，1555.03元。屏幕为15分钟合成K线，当前根只包含截至成交时点的观测。规则回放周期为4小时，复盘观察周期是15分钟，二者用途不同。
-->

---

<DeckPage number="07" section="02 / 还原" title="AI 在输入框里，先猜一句你想写的话" subtitle="根据已有交易行为与偏好，预测这笔交易的理由和原先计划。">
  <div style="width:990px;margin:0 auto"><SuggestionDemo /></div>
  <div class="suggestion-bottom"><div class="key-explainer"><kbd>Tab</kbd>直接填入，继续改写</div><p class="note">灰字保留为预测建议，采用前不写入背景。<br>记不清理由或没有计划，也可以如实记录。</p></div>
</DeckPage>

<!--
点击灰字建议和按Tab后，可切换实际前后截图。我们预测用户当时为什么做、原计划是什么，直接在输入框内呈现完整短句。第4笔的建议为「我想延续上一笔减仓，把剩余持仓兑现，结束这一轮持有」。用户按Tab直接填入，之后可以编辑或清除，Escape可忽略。没有独立的AI待确认稿卡片，也不需要第二次确认流程。此轮首批5/20准备完成，第二批RUN_LIMIT暂停；跨会话语义记忆是后续方案范围。
-->

---

<DeckPage number="08" section="02 / 还原" title="每条判断，都能回到对应证据" subtitle="自动整理相关材料，保留来源、内容和相对决策时点。">
  <div style="width:1080px;margin:8px auto 0"><ProductShot src="evidence.png" alt="交易证据及来源时点" :crop="[.11,.186,.06,.368]" /></div>
  <div class="notes-strip"><div><h3>跟随当前交易</h3><p>材料与成交关联，减少跨页找资料。</p></div><div><h3>来源可以核对</h3><p>保留原始记录与材料时间。</p></div><div><h3>分清信息时点</h3><p>决策后的信息用于看结果，避免倒推依据。</p></div></div>
</DeckPage>

<!--
实际证据页当前是第5笔的成交记录，来源bundle.json，2025-03-07 09:40，买入200股，成交1555.03，费用80.86。来源说明与模拟成交一致。成交记录证明执行事实，动机需结合用户背景；不能仅凭成交记录或事后新闻证明用户当时怎么想。
-->

---

<DeckPage number="09" section="03 / 分析" title="AI 算清交易事实，再解释可选改进" subtitle="一段交易可能包含多个持仓周期，核算和分析使用统一口径。">
  <div class="split wide-shot" style="grid-template-columns:825px 1fr;gap:37px">
    <ProductShot src="review-20.png" alt="真实AI全20笔复盘回答" :crop="[.22,.28,.025,.25]" />
    <div><div class="stat-label">20 笔成交 / 5 个完整周期</div><div class="rule" style="margin:17px 0 22px"></div><div class="stat-label">扣费后净盈亏 · 元</div><div class="value" style="font-size:39px">82,179.41</div><div class="stat-label" style="margin-top:26px">全部费用 · 元</div><div class="value" style="font-size:34px">3,115.59</div><p class="note" style="margin-top:30px">事实、解释与资料缺口分开。<br>每项改进写明依据和代价。</p></div>
  </div>
  <p class="fineprint" style="margin-top:20px">真实 AI 回答，使用合成交易资料。累计买入额不等于账户本金，未给出本金时保留整体收益率未知。</p>
</DeckPage>

<!--
完整20笔真实模型复盘通过。五周期净盈亏分别13255.30、13984.04、14370.21、15671.78、24898.08，合计82179.41；费用3115.59，期末持仓0。此前跨周期汇总工具返回未知的问题已修复。原始买入额2990954、卖出额3076249。没有账户本金就不估整体收益率。盈利与分批行为的因果关系不能直接认定，AI提出的是有前提和代价的可选改进。
-->

---

<DeckPage number="10" section="04 / 检验" title="保留原方法，明确改进了哪条规则" subtitle="把模糊经验变成可检验的入场、退出和风险约束。">
  <div class="method-pair">
    <div><div class="method-title"><h3>跟随均线方向</h3><span class="mini-label">原版</span></div><ProductShot src="method-original.png" alt="原版交易方法规则" :crop="[.22,.23,.277,.19]" style="width:510px" /><div class="method-params"><span>投入 <strong>80%</strong></span><span>无独立止损</span></div></div>
    <div><div class="method-title"><h3>增加风险约束</h3><span class="accent-label">改进版</span></div><ProductShot src="method-improved.png" alt="改进版交易方法规则" :crop="[.22,.23,.277,.13]" style="width:510px" /><div class="method-params"><span>投入 <strong>50%</strong></span><span>止损 <strong>8%</strong></span><span>持有 <strong>20 根 K</strong></span></div></div>
  </div>
</DeckPage>

<!--
真实保存的原版与风险约束版共存。原方法按5根完整K线均价、高于0.5%入场，投入80%。改进版投入50%，完整K线确认亏损8%后退出，最多持有20根。信号后下一可用开盘执行，遵守T+1与整手规则。因此8%是触发阈值，不保证恰好在8%成交。两者都保留，用户可以继续改进并比较。
-->

---

<DeckPage number="11" section="04 / 检验" title="回测前，把比较条件放在台面上" subtitle="在已有行情上检验方法，资金、区间、费用与执行条件保持明确。">
  <div class="split wide-shot" style="grid-template-columns:760px 1fr;gap:55px">
    <ProductShot src="backtest-settings.png" alt="回测标的与资金设置" :crop="[.22,.115,.035,.16]" />
    <div class="copy-stack"><div><div class="stat-label">起始资金 · 元</div><div class="value" style="font-size:39px">850,000</div></div><div><h3>成本计入回放</h3><p>手续费 3 bps<br>滑点 5 bps</p></div><div><h3>执行条件一致</h3><p>100 股整手<br>T+1 卖出约束<br>4 小时规则周期</p></div></div>
  </div>
  <p class="fineprint" style="margin-top:18px">图中两个同标的工作区记录仅选中一个。每个标的独立使用所设资金，结果用于历史验证。</p>
</DeckPage>

<!--
回测页面展示已导入的兼容行情，用户可选择标的、日期与起始资金。本图两个记录都是贵州茅台，不说成两个不同股票。资金85万元，手续费3bps，滑点5bps，100股整手，卖出T+1。50万元不足时已验证阻止比较，85万元时恢复。实际交易案例最大用资837352.22。
-->

---

<DeckPage number="12" section="04 / 检验" title="改进的价值，需要在对照中看见" subtitle="同样本、同资金、同成本，收益与风险的变化一起呈现。" dark>
  <div class="compare-layout">
    <div><div class="compare-head"><div><div class="stat-label">原方法收益率</div><div class="value">15.57<small>%</small></div><div class="result-sub">最大回撤 0.05%</div></div><div><div class="stat-label">风险约束版收益率</div><div class="value">7.43<small>%</small></div><div class="result-sub">最大回撤 0.03%</div></div></div><ProductShot src="method-comparison.png" alt="原方法和改进方法同条件回测表" :crop="[.23,.21,.045,.375]" /></div>
    <div><p class="compare-insight">更强的风险约束，<br>这次带来了<br><em>更低回撤，<br>也更低收益。</em></p><p class="note" style="color:#aaa;margin-top:25px">把取舍展示给用户，<br>让下一轮改进有依据。</p></div>
  </div>
  <p class="fineprint" style="margin-top:17px;color:#888">合成行情回放。净收益含期末持仓估值，与实际模拟成交净现金盈亏使用不同口径。</p>
</DeckPage>

<!--
原方法净收益132323.50，改进方法63167.35，差额-69156.15；收益率15.57%与7.43%，最大回撤0.05%与0.03%。期末可能持仓，净收益含市值，因此不能拿82179.41实际执行净现金盈亏混比。加强风控在这段合成样本中降低收益与回撤；不能推断未来表现或声称所有改进提高收益。
-->

---

<DeckPage number="13" section="05 / 沉淀" title="把经验留成下一次用得上的检查项" subtitle="AI 提炼建议，用户把它改成自己的行动规则。">
  <div class="split narrow-shot" style="grid-template-columns:1fr 465px;gap:75px;padding:0 30px 0 12px">
    <div class="checklist-items"><div><h2>什么时候用</h2><p>每次分批建立仓位或追加买入前。</p></div><div><h2>具体检查什么</h2><p>已投入、本批投入、费用与总预算，<br>核对后留下记录。</p></div><div><h2>遇到例外怎么办</h2><p>预算不明确时标记待补充，<br>调整计划后重新核对。</p></div></div>
    <div style="width:355px;justify-self:center"><ProductShot src="checklist-edit.png" alt="编辑检查项的触发、动作与例外" :crop="[.258,.053,.258,.053]" /></div>
  </div>
</DeckPage>

<!--
真实编辑弹窗有名称、触发条件、检查动作、例外四个字段。当前检查项「分批交易前核对预算」已保存，并验证再次打开可编辑。它是面向下一次的流程提醒，依据用户现在的回忆整理，不证明用户过去执行过。
-->

---

<DeckPage number="14" section="产品预期形态" title="自己的复盘，也可以接上更多参考" subtitle="在已有核心链路上，继续丰富数据、记忆与方法来源。">
  <div class="future-grid"><div><div class="future-no">01</div><h3>更自由的数据进入方式</h3><p>扩展多格式文件识别、交易所与链上专用接口，保留统一核对流程。</p></div><div><div class="future-no">02</div><h3>持续理解用户的习惯</h3><p>积累跨会话偏好与历史背景，让框内预测越来越贴合用户。</p></div><div><div class="future-no">03</div><h3>可追溯的高手方法</h3><p>保留作者与原始材料，结构化对照规则，再用相同条件回测。</p></div></div>
  <p class="fineprint" style="position:absolute;bottom:91px">本页展示产品方案的延展方向，当前验证范围见测试附录。</p>
</DeckPage>

<!--
用户要求展示最终预期产品形态。这里明确承接三类方向：任意格式输入体验、交易所链上API专用适配、跨会话语义记忆和高手方法。高手方法需标注来源、适用市场、入场退出和参数局限。保留这些规划亮点，同时不伪造尚不存在的界面或已接入的账户。
-->

---

<DeckPage number="15" section="测试 / 主链路" title="高频案例已经沿核心链路走通" subtitle="以一组真实标的的模拟交易，串起导入、复盘、方法、回测与检查项。">
  <div class="test-metrics"><div><div class="value">20<small>笔</small></div><div class="stat-label">真实模型复盘的主案例</div></div><div><div class="value">2<small>版方法</small></div><div class="stat-label">原版与风险约束版保存</div></div><div><div class="value">1<small>项</small></div><div class="stat-label">可再次编辑的交易前检查</div></div></div>
  <div style="display:grid;grid-template-columns:570px 1fr;gap:44px;align-items:center"><ProductShot src="checklist-library.png" alt="保存后的检查项库与交易方法" :crop="[0,0,.2,.37]" /><div class="copy-stack" style="gap:22px"><div><h3>结果核算一致</h3><p>20 笔、5 周期，净盈亏与费用均已核对。</p></div><div><h3>沉淀内容可继续使用</h3><p>方法和检查项保存后可重开，<br>刷新恢复已有材料与编辑。</p></div><p class="note">主链路用例 M01 / M03–M07<br>配套测试说明记录操作、预期与实际结果。</p></div></div>
</DeckPage>

<!--
主案例真实UI和真实模型验收：标准资料包导入、20笔AI复盘、保存原版与风险约束版、85万同条件回测、编辑保存检查项、刷新恢复。before-refresh与after-refresh的trade/context/evidence/messages/research/methods/checklist指纹一致，快照早于最后全20新回答，不扩大到后续所有状态。
-->

---

<DeckPage number="16" section="测试 / 缺失与失败" title="缺少数据时提示，失败后保留已完成内容" subtitle="覆盖导入缺失与接口失败，用户可以补齐或继续手动处理。">
  <div class="split wide-shot" style="grid-template-columns:740px 1fr;gap:48px"><ProductShot src="import-missing-time-blocked.png" alt="缺成交时间时导入确认禁用" :crop="[.14,.277,.14,.075]" /><div class="copy-stack"><div><h3>缺少成交时间</h3><p>指出需要补充的字段，<br>确认导入保持禁用。</p></div><div><h3>准备请求中断</h3><p>已完成内容保留，<br>提供继续入口和手动补充。</p></div><p class="note">本次背景自动准备首批 5 / 20 成功。<br>第二批因运行上限暂停，整组尚未完成。</p></div></div>
  <p class="fineprint" style="margin-top:24px">接口失败、缺数据和保存失败另有受控测试。图中为真实缺时间导入场景。</p>
</DeckPage>

<!--
D01：缺时间CSV显示待补充，确认禁用；取消后原20笔不变。M02/D04：旧轮MODEL_ERROR和新轮RUN_LIMIT都没有覆盖已完成首批；提供继续与手动补充。新轮5/20成功，未声称20/20背景自动准备完成。只读接口401、超时、空列表、保存失败等测试使用受控环境，不把受控通过说成所有外部服务接入成功。
-->

---

<DeckPage number="17" section="测试 / 极端与判断边界" title="核心可用之外，守住数据和判断边界" subtitle="自动测试与真实操作各有范围，结果分开报告。">
  <table class="test-table"><thead><tr><th>场景</th><th>检查内容</th><th>结果与证据类型</th></tr></thead><tbody><tr><td>极端资金与输入</td><td>50 万元不足时阻止比较，补至 85 万元后恢复。<br>拒绝无效数值，核对整手、T+1 与平价行情。</td><td>真实 UI + 受控测试</td></tr><tr><td>信息时点</td><td>当时可知与后续结果分开，当前未收盘 K 线单独标记。<br>现在回忆保留来源，预测内容不升级为历史事实。</td><td>真实 UI + 受控测试</td></tr><tr><td>投资判断边界</td><td>核算和分析保留依据与缺口，拒绝直接买卖指令和收益承诺。<br>取消或材料变化后，迟到结果不能覆盖新状态。</td><td>受控测试</td></tr></tbody></table>
  <div style="display:flex;gap:58px;align-items:flex-end;margin-top:26px"><div><span class="value" style="font-size:35px">569</span><span class="muted" style="font-size:14px;margin-left:10px">项自动测试通过</span></div><div><span class="value" style="font-size:35px">50</span><span class="muted" style="font-size:14px;margin-left:10px">组离线模拟数据</span></div><p class="fineprint" style="width:350px">50 组共 1,500 笔交易、16,000 根 15 分钟 K 线。<br>44,510 个适用断言通过，模型调用 0 次。</p></div>
</DeckPage>

<!--
50组是10个真实A股身份乘5种模拟情境，每组20至40笔，总计1500笔，16000根15分钟合成K线。44510个适用断言通过，0次模型调用。该结果衡量离线数据与契约校验，真实AI质量按实际运行案例单列。基线569项自动测试通过，随后引用折叠另有16项定向测试通过。详细测试说明覆盖主链路、数据缺失/接口失败、极端/合规边界。后续效果评测再评价建议可执行性、依据一致性和交互负担。
-->

---

<div class="closing">
  <div class="brand">TradingReview<span class="brand-dot"></span></div>
  <div class="closing-copy"><h1>把一次复盘，<br>留给下一次交易。</h1><p>回到当时的背景，<br>看清自己的方法，<br>记住下一次要检查的事。</p><a class="live-link" href="http://127.0.0.1:8791/" target="_blank" rel="noopener">打开产品演示 ↗</a></div>
  <div class="closing-shot"><ProductShot src="workspace.png" alt="真实复盘工作台全景" /></div>
  <div class="closing-note">演示标的身份真实，行情、成交与用户行为均为模拟。测试边界与讲稿随源文件提供。</div>
</div>

<!--
总结主线后打开真实产品即可接着演示。现场可以从贵州茅台复盘进入材料，切换15分钟当时可知，查看灰字建议，再到交易方法与检查项库。所有配图来自本机实页截图，Slidev只增加展示框、圆角、阴影与注释，不重绘产品界面。
-->


