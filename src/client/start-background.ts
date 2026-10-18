/**
 * 起始界面动态牌面背景（S1 拆分）。
 *
 * 从 app.ts 搬出来的一整块，行为零变化：常量、缓存、随机、铺瓦片、挂载/卸载
 * 全部原样迁移，call site 一处没动。这个模块**不需要** context.ts 的桥：
 * 它不读任何对局/账号状态，只依赖 shared/cards 的牌表、format 的配色与 dom 的转义。
 *
 * 注意：常量必须留在模块顶层且在任何调用之前完成初始化。app.ts 在文件中部就会调用
 * render()，而 render() 会立即调用 ensureStartScreenBackground()。由于本模块是被
 * app.ts 在文件头 import 的，模块体先于 app.ts 的模块体执行，因此这些 const 在首次
 * 渲染时已经就绪，不存在 TDZ 风险。
 */
import { CARDS, FORMULA_HTML, LABELS } from "../shared/cards.js";
import type { CardId, CardKind } from "../shared/types.js";
import { escapeAttr, escapeHtml } from "./dom.js";
import { coloredIonStyle, kindName } from "./format.js";
import type { StartScreenMosaicCard } from "./types.js";

// ---------------------------------------------------------------------------
// 常量与缓存
// ---------------------------------------------------------------------------

const START_BG_TILE_MIN = 360;
const START_BG_TILE_MAX = 560;
const START_BG_CARDS_PER_TILE = 18;
// 设置弹窗里「开始界面动画显示」写的就是这个键；本模块只读它。
const START_ANIMATION_KEY = "ionStormStartAnimation";

/**
 * 主界面背景动画是否开启。没写过按「开」处理（老用户体验不变），
 * 只有明确存成 "0" / "false" / "off" 才算关。
 * 关掉后牌面依然随机生成、铺满视口，只是把 CSS 动画钉在 0% 帧上：
 * 每次刷新位置都会重新随机，但整块幕布静止不动。
 */
export function startScreenAnimationEnabled(): boolean {
  const raw = (localStorage.getItem(START_ANIMATION_KEY) ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * 把当前偏好应用到已经挂载的幕布上——设置里刚切完开关时立刻生效，不用等下一次重建。
 * 用 animation-play-state 而不是重建元素：重建会连随机方向、速度、牌面一起换掉，
 * 玩家看到的就是「关一下开关，背景整体跳了一下」。重新打开时动画从暂停处继续。
 */
export function applyStartScreenAnimation(enabled = startScreenAnimationEnabled()): void {
  const layer = document.getElementById("lobbyBg")?.querySelector<HTMLElement>(".lobby-bg-layer");
  if (!layer) return;
  layer.style.animationPlayState = enabled ? "" : "paused";
}
// 幕布方向：0° / ±45° / ±90° / ±135° / 180°。每次刷新随机取一个，
// 用单位向量表示 —— 位移 = 单位向量 × 整数倍 TILE，方向精确、绝不会是「小角度摆动」。
const START_BG_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], // 0°
  [1, 1], // 45°
  [0, 1], // 90°
  [-1, 1], // 135°
  [-1, 0], // 180°
  [-1, -1], // -135°
  [0, -1], // -90°
  [1, -1], // -45°
];
const START_BG_SPEED_MIN = 16;
const START_BG_SPEED_MAX = 42;
// 铺瓦片时的额外余量（瓦片数）：保证即使目标位移漏算，也还有一整圈兜底，
// 不会在屏幕边缘露出空白。
const START_BG_TILE_MARGIN = 2;

/**
 * 已生成的背景缓存：key 为视口尺寸，mosaic 为铺好的牌面 HTML。
 * 离开起始界面时清空，因此每次重新进入都会重新随机方向、速度与牌面。
 */
const startBgCache: { key: string; html: string } = { key: "", html: "" };

// ---------------------------------------------------------------------------
// 起始界面动态牌面背景
//
// 原理：把牌随机铺在一个 TILE×TILE 的「瓦片」里，并对每张牌在其 3×3 邻接瓦片上各
// 复制一份。整层平移 (TILE, 0) 或 (0, TILE) 后与自身完全重合，因此让动画在
// TILE 距离内平移就能得到无缝循环的「循环幕布」效果（方向由随机角度决定）。
// 长距离移动通过 --bg-slide-x / --bg-slide-y 放大 TILE 得到，速度保持恒定。
// ---------------------------------------------------------------------------

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** 与 renderCard 观感一致，但不需要已开局的对局状态（起始界面无 game）。 */
function startScreenCardFaceHtml(id: CardId): string {
  const def = CARDS[id];
  const color = startScreenIonColor(id);
  const formulaStyle = color ? ` style="color:${escapeAttr(color)}"` : "";
  return `<span class="formula"${formulaStyle}>${FORMULA_HTML[id] ?? escapeHtml(LABELS[id] ?? id)}</span><span class="kind">${escapeHtml(
    `${kindName(def?.kind)}${def?.charge ? ` · ${def.charge > 0 ? "+" : ""}${def.charge}` : ""}`,
  )}</span>`;
}

function startScreenIonColor(id: CardId): string | undefined {
  const match = /color:\s*(#[0-9A-Fa-f]{3,8})/.exec(coloredIonStyle(id));
  return match?.[1];
}

function startScreenMosaicCards(count: number = START_BG_CARDS_PER_TILE): StartScreenMosaicCard[] {
  const deck = Object.keys(CARDS).filter((id) => CARDS[id]);
  const cards: StartScreenMosaicCard[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomItem(deck);
    const def = CARDS[id];
    cards.push({
      html: `<div class="card bg-card ${def?.kind ?? "function"}" style="--card-top-color:${escapeAttr(defaultTopColorForKind(def?.kind ?? "function"))}">${startScreenCardFaceHtml(id)}</div>`,
      x: Math.random(),
      y: Math.random(),
      scale: randomBetween(0.66, 1.32),
      // 旋转幅度与透明度都刻意压低：背景只做「氛围幕布」，不能喧宾夺主。
      rotate: randomBetween(-7, 7),
      opacity: randomBetween(0.15, 0.28),
      z: Math.floor(randomBetween(1, 60)),
    });
  }
  return cards;
}

function defaultTopColorForKind(kind: CardKind): string {
  if (kind === "cation") return "#b63e32";
  if (kind === "anion") return "#226b70";
  if (kind === "special") return "#c6972f";
  return "#6b5aa9";
}

function renderStartScreenBackground(): string {
  const width = Math.max(320, window.innerWidth);
  const height = Math.max(320, window.innerHeight);
  const key = `${width}x${height}`;
  if (startBgCache.key === key && startBgCache.html) return startBgCache.html;

  // 方向：从 8 个精确方向里随机取一个（0° / ±45° / ±90° / ±135° / 180°）。
  const [dirX, dirY] = randomItem(START_BG_DIRECTIONS);
  // TILE 取整：牌位坐标是 tileX * TILE + 瓦片内整数偏移，若 TILE 带小数，
  // 相邻瓦片之间会累积亚像素误差，接缝处就能看出错位。
  const tile = Math.round(
    Math.min(
      START_BG_TILE_MAX,
      Math.max(START_BG_TILE_MIN, Math.max(width, height) * randomBetween(0.42, 0.58)),
    ),
  );
  // 一个循环走整数个周期：位移是 TILE 的整数倍，因此终点帧与起点帧覆盖的是
  // 同一张图案，animation 循环时不会「弹回开头」，是真正的无限滚动。
  // 走得多一点（1~3 个周期）纯粹是为了让循环点之间隔久一些，也更有变化。
  const cycles = Math.min(3, Math.max(1, Math.round(Math.max(width, height) / tile)));
  const travel = tile * cycles;
  const slideX = dirX * travel;
  const slideY = dirY * travel;
  // 速度按实际位移算，与上面反解出的距离一致（px/s）。
  const speed = randomBetween(START_BG_SPEED_MIN, START_BG_SPEED_MAX);
  const duration = Math.max(12, Math.hypot(slideX, slideY) / speed).toFixed(3);

  const placements: string[] = [];
  // 铺瓦片范围必须覆盖「视口 ∪ 视口在动画期间平移到的终点」，否则滚到末端时
  // 某条边会露出空白。所有方向都是直线运动，起点到终点这条路径上每个位置都夹在
  // 两个端点的并集里，所以铺「两端的并集」就够，不必铺满整个包围盒。
  // slide 为负时动画朝坐标轴负方向走，取 [slideTiles, 0] 才落在起点一侧。
  const baseTileX = Math.ceil(width / tile) + 1;
  const baseTileY = Math.ceil(height / tile) + 1;
  const slideTilesX = Math.round(slideX / tile);
  const slideTilesY = Math.round(slideY / tile);
  const xFrom = -baseTileX + Math.min(0, slideTilesX);
  const xTo = baseTileX + Math.max(0, slideTilesX);
  const yFrom = -baseTileY + Math.min(0, slideTilesY);
  const yTo = baseTileY + Math.max(0, slideTilesY);
  // 瓦片变多时按面积等比减少每瓦片的牌数，保持屏幕上看到的牌面密度恒定，
  // 同时把 DOM 节点数压在合理范围（否则 ±45° 时会铺到上万张）。
  const areaInTiles = Math.max(1, (xTo - xFrom) * (yTo - yFrom));
  const cardCount = Math.max(
    8,
    Math.min(START_BG_CARDS_PER_TILE, Math.round((START_BG_CARDS_PER_TILE * 3) / areaInTiles)),
  );
  const cards = startScreenMosaicCards(cardCount);
  // 每张牌的瓦片内偏移量取整为整数像素，这样相邻瓦片同名牌的间距严格等于 TILE，
  // 与动画终点帧的平移量完全吻合，接缝处不会有亚像素错位。
  const offsets = cards.map((card) => ({
    card,
    offsetX: Math.min(tile - 1, Math.round(card.x * tile)),
    offsetY: Math.min(tile - 1, Math.round(card.y * tile)),
  }));
  for (let tileY = yFrom; tileY <= yTo; tileY++) {
    for (let tileX = xFrom; tileX <= xTo; tileX++) {
      for (const { card, offsetX, offsetY } of offsets) {
        placements.push(
          `<div class="bg-card-slot" style="left:${tileX * tile + offsetX}px;top:${tileY * tile + offsetY}px;z-index:${card.z};opacity:${card.opacity.toFixed(2)};transform:rotate(${card.rotate.toFixed(1)}deg) scale(${card.scale.toFixed(2)})">${card.html}</div>`,
        );
      }
    }
  }

  startBgCache.key = key;
  startBgCache.html = `
    <div class="lobby-bg-layer" style="--bg-slide-x:${slideX}px;--bg-slide-y:${slideY}px;--bg-slide-duration:${duration}s">
      ${placements.join("")}
    </div>
  `;
  return startBgCache.html;
}

/**
 * 把背景幕布挂到 #app 之外（每次渲染都会被整体替换的是 #app 内部）。
 *
 * render() 用 app.innerHTML = ... 重建整棵树，只要背景在 #app 里面就一定会被销毁，
 * 新元素上的 CSS 动画会从 0 重新开始 —— 表现就是「点一下按钮，幕布跳回原位」。
 * 放在 #app 之外后元素终生只创建一次，动画在多次渲染之间连续不断。
 */
export function ensureStartScreenBackground(): void {
  const host = document.getElementById("lobbyBg");
  // 只在「容器不存在」或「缓存已失效」时重建，绝不因为 HTML 字符串差异而重写：
  // 解析后的 innerHTML 与模板字符串的空格/换行未必逐字相同，用字符串比较做守卫会
  // 每次都判定为「有变化」，从而重建 .lobby-bg-layer 并把动画打回起点。
  const layer = host?.querySelector(".lobby-bg-layer");
  if (!host || !layer || startBgCache.key !== `${Math.max(320, window.innerWidth)}x${Math.max(320, window.innerHeight)}`) {
    const target = host ?? createStartScreenBackgroundHost();
    target.innerHTML = renderStartScreenBackground();
  }
  // 不管这次有没有重建，都按当前偏好对齐一次：关掉动画时把幕布钉在 0% 帧（牌面照常随机铺开）。
  // 与上面同步执行，浏览器还没机会绘制，所以不会出现「先动一帧再停」的闪烁。
  applyStartScreenAnimation();
}

function createStartScreenBackgroundHost(): HTMLElement {
  const host = document.createElement("div");
  host.id = "lobbyBg";
  host.className = "lobby-bg";
  host.setAttribute("aria-hidden", "true");
  // 原来直接用 app.ts 顶部的 `const app = document.querySelector("#app")!`。
  // 这里重新查一次同一个元素（模块脚本执行时 #app 必然已存在），插到 #app 之前，
  // 保证 #app 画在幕布之上，与拆分前的层级完全一致。
  const appRoot = document.querySelector<HTMLDivElement>("#app");
  document.body.insertBefore(host, appRoot);
  return host;
}

/** 离开起始界面时丢弃缓存，下次重新进入会重新随机方向、速度与牌面。 */
export function resetStartScreenBackground(): void {
  startBgCache.key = "";
  startBgCache.html = "";
  document.getElementById("lobbyBg")?.remove();
}
