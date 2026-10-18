/**
 * DOM / 字符串层面的纯工具（S0 地基）。
 *
 * 只依赖 document 与 shared 里的静态数据，不读任何游戏状态，
 * 所以从 app.ts 搬出来之后所有 call site 一行都不用改。
 */
import { FORMULA_HTML, LABELS, isIon } from "../shared/cards.js";

/** 把用户输入塞进 HTML 文本节点时的转义。 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** 塞进属性值时的转义（在 escapeHtml 之上再挡反引号）。 */
export function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/`/g, "&#96;");
}

export function cssEscape(value: string): string {
  return CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** 屏幕右下角的临时提示条。 */
export function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

/** 复制文本：优先用剪贴板 API，失败时退回老式的 execCommand 路径。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy, user-gesture-friendly clipboard path.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

/** 从一行表格里取带 data-user-field 的输入框的值。 */
export function fieldValue(row: HTMLElement, field: string): string | undefined {
  const input = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-user-field="${field}"]`);
  return input?.value;
}

export function inputValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLInputElement | null)?.value;
}

export function selectValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLSelectElement | null)?.value;
}

export function textAreaValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value;
}

export function setSelectValue(id: string, value: string): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (select) select.value = value;
}

/** 出牌记录里把离子牌名换成带上标下标的化学式，按名字从长到短替换，避免前缀互相吃掉。 */
const LOG_ION_FORMATS = Object.keys(FORMULA_HTML)
  .filter((card) => isIon(card))
  .map((card) => ({ label: LABELS[card], html: FORMULA_HTML[card] }))
  .sort((a, b) => b.label.length - a.label.length);

export function renderGameLog(input: string): string {
  let html = escapeHtml(input);
  for (const ion of LOG_ION_FORMATS) html = html.replaceAll(escapeHtml(ion.label), ion.html);
  return html;
}
