# 投资决策复盘与学习 · Slidev 产品介绍

18 页可交互演示，包含真实页面截图、产品主链路、预期能力与三类测试说明。示例采用真实股票身份，行情、成交及用户行为为模拟数据；已验证范围写在页面及讲稿中。

## 本地运行

拿到包含 `dist/` 的完整交付包后，只需安装 Node.js，在本目录运行：

```powershell
node preview.mjs
```

打开 <http://127.0.0.1:3031/> 即可查看编译版，无需 `npm install` 或 `node_modules/`。也可使用 `npm run preview`。预览服务仅监听本机，支持演示页直达与刷新；停止使用 `Ctrl+C`。

需要编辑内容时，再启动开发版：

安装 Node.js **22.12 或更高版本**，在本目录打开 PowerShell 7：

```powershell
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:3030/>。启动脚本自动设置 `NODE_OPTIONS=--dns-result-order=ipv4first`，适配 Windows 本地 IPv4 访问，无需手动配置环境变量。停止服务使用 `Ctrl+C`。

## 演示入口

- 点击截图打开高清原图，点击「关闭」或按 `Esc` 返回。
- 「数据入口」页可切换只读 API、扶摇、iFinD 三张实际配置截图。
- 「框内灰字」页可切换建议与按 Tab 采用后的实际截图。
- 结尾的「打开产品演示」指向本机 `http://127.0.0.1:8791/`，需要单独运行产品服务。

`public/screens/` 保留原始 **3840 × 2160 PNG**。页面通过 CSS 等比裁切、圆角和阴影展示；未重新采样图片。截图交互用于演示已记录的页面状态。

## 构建与交付

```powershell
npm run build
```

生成的 `dist/` 是静态演示网站，可交给支持单页应用路由回退的 HTTP 静态服务器部署或预览。请通过 HTTP 地址访问，避免直接双击 `dist/index.html`。

| 内容 | 用途 |
|---|---|
| `slides.md` | 18 页内容，HTML 注释中包含逐页讲稿与事实边界 |
| `components/`、`layouts/`、`style.css` | 可编辑的交互组件与版式 |
| `public/screens/` | 原始高清页面截图 |
| `package.json`、`package-lock.json`、`run-slidev.mjs` | 安装依赖及可复现的启动入口 |
| `preview.mjs` | 无第三方依赖的本机静态预览，默认端口 3031 |
| `dist/` | 构建后的演示网站；源文件调整后需重新构建 |

源文件用于继续编辑；`dist/` 用于浏览和部署。静态交付不需要包含 `node_modules/`，也不包含产品后端。完整验收范围见随包附带的 [正式测试说明](docs/测试说明.md)。
