# baseline — 改造前的原始文件基线

本目录保存**起始界面改造开始之前**的原始文件，仅用于对照与恢复，不参与构建。

## 来源

- 归档：`D:\Projects\ion-storm-main.zip`（创建于 2026-09-24 20:08，早于改造会话）
- 该 zip 是项目的完整原始快照（73 个条目），不含 `dist/`、`node_modules/`
- 已确认它是干净的：`lobby-*`、`start-screen`、`renderStartScreenBackground`、`START_BG_DIRECTIONS`、`data-backdrop-dismiss` 等改造引入的标识符在其中的出现次数均为 **0**

## 文件校验

| 文件 | 字节 | SHA256 |
| --- | --- | --- |
| `styles.css` | 61103 | `9AD899738CF065E4D51E8EDA152CD83137F9DC38F34AD0F8D6E90A8DEE400A38` |
| `app.ts` | 471172 | `3454F304F70105819167C04C1A2600944125AD589C412F3238455BDDDDE2B8BD` |

两份均已与 zip 内条目做 SHA256 比对，**完全一致**（字节级拷贝，未经任何编码往返）。

## 改动范围

对 zip 内全部 63 个文件与项目逐字节比对，结果：

- **61 个完全相同**（从未被动过）
- **2 个不同**：`src/client/app.ts`、`src/client/styles.css`

即本基线覆盖了全部改动范围，其余文件无需备份。

## 两个文件的现状说明

### `src/client/styles.css` — 曾被破坏并重建

原始文件在一次 PowerShell 5.1 的 UTF-8 读写往返中被按 CP936 解码，写成了 **0 字节**。
当前版本是从当时的构建产物 `dist/client/assets/index-MQ7T9rxb.css` 反推重建的。

已丢失：

- 全部原始排版（多行声明被压成紧凑 `prop:value`）
- **3 条注释**（第 571、1895、3011 行，均为解释「为什么这么写」的说明）
- 选择器被 lightningcss 规范化：`:nth-child(1)`→`:first-child`、`[type="checkbox"]`→`[type=checkbox]`、`.a > .b`→`.a>.b`、`::before`→`:before`、`@media (max-width: 600px)`→`@media (width<=600px)`
- `:root` 中混入了 2 个 lightningcss 内部变量 `--lightningcss-light` / `--lightningcss-dark`

已核对未丢失：

- 原始 **543 条规则全部存在**，选择器完整保留（其中 2 对被合并为一条）
- 账目精确：`543 + 33(新增) − 2(合并) = 574` = 当前规则总数
- 新增的 33 条全部属于起始界面／幕布背景
- 其余「声明不同」均为等价写法差异：声明顺序、`rgba(255,255,255,0.45)`→`#ffffff73`、`0.45`→`.45`、`transparent`→`0 0`、`0 1px 0`→`0 1px`、`animation: pulse 0.9s infinite`→`.9s infinite pulse`
- 唯一真实行为差异：`body` 的 `min-height: 100vh` 回退被去除，只剩 `100dvh`（2022 年后的浏览器无影响）

### `src/client/app.ts` — 正常定点编辑

原始 9227 行 → 当前 9486 行，共 **16 处改动块**，**+275 / −16 行**，改动块之外内容原样保留。

## 只读保护

`styles.css` 与 `app.ts` 已设置只读属性，防止被工具或脚本意外覆盖（本 README 保持可写，便于追加记录）。

需要临时解除只读：

```powershell
Set-ItemProperty baseline\styles.css -Name IsReadOnly -Value $false
Set-ItemProperty baseline\app.ts    -Name IsReadOnly -Value $false
```

## 常用对照

```powershell
# 与当前文件逐行对照
Compare-Object (Get-Content baseline\styles.css) (Get-Content src\client\styles.css)

# 校验基线未被改动
Get-FileHash baseline\styles.css, baseline\app.ts -Algorithm SHA256
```

## 构建隔离

三个 tsconfig 的 `include` 分别限定为 `src/`、`src/server`+`src/shared`、`worker/**`+`src/shared/**`，
Vite 的入口是 `./index.html`，因此本目录**不会**参与 `npm run build` 的任何一步。
