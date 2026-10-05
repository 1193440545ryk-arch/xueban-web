# 学伴 · 浏览器本地版

这个目录是独立静态网站项目，可以单独建 GitHub 仓库。用户选择的文档在浏览器内处理，没有登录、上传接口或转换服务器。现有 `mobile/` Python 网页版及桌面客户端不受影响。

## 本地使用

要求 Node.js 22.12+（推荐 24）和 pnpm 11.19。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

浏览器打开终端显示的 `http://127.0.0.1:4173/`。需要 HTTP/HTTPS 运行，不能直接双击 HTML。首次 `build` 会准备自托管 PDF 字体、CMap 和 WASM 资源。运行 `pnpm preview` 可在 4174 端口查看生产构建。

电脑 Chrome / Edge 是本版验收目标。选中的文件及结果仅留在当前页面；刷新/关闭页面前请下载。清空任务不会删除用户电脑上已保存的文件。不承诺离线使用或 30 天文件保留。

## 发布到 GitHub Pages

1. 创建独立公开仓库，将 **web-local 目录里面的项目文件**放在该仓库根目录，保留 `.github`、`.gitignore` 和锁文件。不要把父级桌面项目、`.mobile-data`、访问码、用户文件或安装包加入 Git 仓库。
2. 推送到 `main` 分支。在仓库 Settings → Pages → Build and deployment 将 Source 选择为 **GitHub Actions**。首次推送可能早于 Pages 启用；设置完成后，到 Actions → Publish Xueban static website → Run workflow，选择 `main` 手动运行一次。
3. `.github/workflows/pages.yml` 会安装固定版本依赖、测试、构建并发布 `main` 的最新代码。打开 Actions 查看结果；域名使用 Pages 页面提供的地址。以后发布客户端 Release 也会刷新网站下载入口，不会将网站退回旧标签对应的代码。
4. 实际用中国内地不同网络打开网页，测试图片、PDF 和安装包下载。GitHub Pages 的访问速度不作保证。
5. 后续更新仅推送网页项目。构建使用相对路径，支持 `用户名.github.io/仓库名/` 子目录。

项目没有预填备案号、真实域名、GitHub 用户名或访问分析服务。若以后迁到境内托管，完成适用的备案手续，并在页面显示真实信息。

## 让安装包下载按钮生效

当前元数据为桌面版 1.19.0，对应既有安装包，不把 370 MB 二进制写入网页仓库。

1. 在同一个 GitHub 仓库创建正式 Release，tag 为 `v1.19.0`。
2. 将现有 `dist/学伴工作台-1.19.0-Windows-x64-Setup.exe` 上传为 Release 附件，文件名不要改变。发布前核对版本、文件大小及 SHA256。
3. 发布 Release 后工作流会再次部署。只有资产文件名、大小与 GitHub 提供的 SHA256 摘要均匹配 `public/releases.json`，才自动生成下载链接。
4. 新版本先更新 `public/releases.json` 的全部元数据，再发布同版本 Release。也可直接把已验证的 HTTPS 正式下载地址填入 `url`。

`url` 为空时，生产页面会明确显示下载地址尚未配置。开发服务器只在本机 127.0.0.1 提供已存在安装包的预览下载；该路径不会进入生产构建。

## 验证

```powershell
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

浏览器测试覆盖真实 Worker 文件处理、PDF 页数与图片导出、DOCX 预览确认、本地下载、子目录部署以及没有文件上传请求。Windows 可使用已安装的 Edge 运行测试，见测试配置。

## 依赖和限制

依赖由锁文件固定；网页不从第三方 CDN 动态加载脚本。构建会把依赖许可证和版本记录写入站点 `licenses/`，PDF.js 字体资源也携带其原始许可证。公式预览使用 KaTeX，图片公式识别本版提示使用桌面客户端，未把“可预览”宣传为“可识别”。

PDF 扫描件不会自动 OCR；复杂表单/签名等不保证编辑后完整保留。Word→PDF 完整保真转换不在本版范围。TXT/Markdown 的 PDF 导出采用隔离的打印预览，由浏览器打印窗口保存，分页与字体由实际电脑决定。

## 文件结构

- `src/main.js`：界面和交互。
- `src/task-manager.js`：本地队列、取消、内存释放、下载与打印。
- `src/workers/processor.worker.js`：按任务加载处理器。
- `src/processors/`：图片、PDF、文档、基础论文处理。
- `public/releases.json`：安装包发布信息。
- `scripts/`：本地资源整理与可公开构建检查。
- `dist-web/`：生成的静态网站，勿手工维护。

