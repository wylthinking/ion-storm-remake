const FORMULA_PREFIX = /^[\s\uFEFF]*[=+\-@]/u;
const SAFE_ACCOUNT_NAME = /^[\p{L}\p{N}_-]+$/u;

export function assertSpreadsheetSafeText(value: string | undefined, label: string): void {
  if (value !== undefined && FORMULA_PREFIX.test(value)) {
    throw new Error(`${label}不能以 =、+、- 或 @ 开头`);
  }
}

export function assertSpreadsheetSafeAccountName(value: string, label: string): void {
  assertSpreadsheetSafeText(value, label);
  if (!SAFE_ACCOUNT_NAME.test(value)) throw new Error(`${label}只能包含文字、数字、下划线或短横线`);
}

export function assertSpreadsheetExportIdentity(value: string | undefined, label: string): void {
  if (value === undefined || value === "") return;
  try {
    assertSpreadsheetSafeText(value, label);
  } catch {
    throw new Error(`检测到旧数据中的不安全${label}，请先修改后再导出 CSV`);
  }
}

export function assertSpreadsheetExportAccountName(value: string | undefined, label: string): void {
  if (value === undefined || value === "") return;
  try {
    assertSpreadsheetSafeAccountName(value, label);
  } catch {
    throw new Error(`检测到旧数据中的不安全${label}，请先修改后再导出 CSV`);
  }
}

/** Neutralize spreadsheet formulas before applying ordinary RFC 4180 quoting. */
export function spreadsheetCsvCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
