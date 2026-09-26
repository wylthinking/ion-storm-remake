import { CUSTOM_LIMITS } from "./custom-rules-types.js";

export type FormulaValue = number | boolean | string;

export type FormulaAst =
  | { kind: "number"; value: number }
  | { kind: "path"; path: string[] }
  | { kind: "unary"; op: "-"; arg: FormulaAst }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: FormulaAst; right: FormulaAst }
  | { kind: "compare"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: FormulaAst; right: FormulaAst }
  | { kind: "call"; name: FormulaFunctionName; args: FormulaAst[] };

export type FormulaFunctionName = "ceil" | "floor" | "round" | "min" | "max" | "abs" | "next";

const FUNCTIONS: Record<FormulaFunctionName, number | [number, number]> = {
  ceil: 1,
  floor: 1,
  round: 1,
  min: [1, 8],
  max: [1, 8],
  abs: 1,
  next: 1,
};

export interface FormulaScope {
  resolvePath(path: string[]): FormulaValue | undefined;
  callFunction?(name: string, args: FormulaValue[]): FormulaValue | undefined;
}

export class FormulaError extends Error {}

interface Token {
  kind: "number" | "ident" | "op" | "lparen" | "rparen" | "comma" | "dot";
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push({ kind: "number", text: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: "ident", text: source.slice(i, j) });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      tokens.push({ kind: "op", text: two });
      i += 2;
      continue;
    }
    if ("+-*/^<>".includes(ch)) {
      tokens.push({ kind: "op", text: ch });
      i += 1;
      continue;
    }
    if (ch === "(") tokens.push({ kind: "lparen", text: ch });
    else if (ch === ")") tokens.push({ kind: "rparen", text: ch });
    else if (ch === ",") tokens.push({ kind: "comma", text: ch });
    else if (ch === ".") tokens.push({ kind: "dot", text: ch });
    else throw new FormulaError(`公式包含非法字符 "${ch}"`);
    i += 1;
  }
  if (tokens.length > CUSTOM_LIMITS.maxFormulaTokens) {
    throw new FormulaError(`公式过长（token 数超过 ${CUSTOM_LIMITS.maxFormulaTokens}）`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parseExpression(depth = 0): FormulaAst {
    if (depth > CUSTOM_LIMITS.maxFormulaAstDepth) {
      throw new FormulaError(`公式嵌套深度超过 ${CUSTOM_LIMITS.maxFormulaAstDepth}`);
    }
    return this.parseComparison(depth);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new FormulaError("公式意外结束");
    this.pos += 1;
    return token;
  }

  private parseComparison(depth: number): FormulaAst {
    const left = this.parseAdditive(depth);
    const token = this.peek();
    if (token?.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.text)) {
      this.take();
      const right = this.parseAdditive(depth + 1);
      return { kind: "compare", op: token.text as never, left, right };
    }
    return left;
  }

  private parseAdditive(depth: number): FormulaAst {
    let left = this.parseMultiplicative(depth);
    for (;;) {
      const token = this.peek();
      if (token?.kind === "op" && (token.text === "+" || token.text === "-")) {
        this.take();
        const right = this.parseMultiplicative(depth + 1);
        left = { kind: "binary", op: token.text as "+" | "-", left, right };
      } else return left;
    }
  }

  private parseMultiplicative(depth: number): FormulaAst {
    let left = this.parsePower(depth);
    for (;;) {
      const token = this.peek();
      if (token?.kind === "op" && (token.text === "*" || token.text === "/")) {
        this.take();
        const right = this.parsePower(depth + 1);
        left = { kind: "binary", op: token.text as "*" | "/", left, right };
      } else return left;
    }
  }

  private parsePower(depth: number): FormulaAst {
    const base = this.parseUnary(depth);
    const token = this.peek();
    if (token?.kind === "op" && token.text === "^") {
      this.take();
      const exponent = this.parsePower(depth + 1);
      if (exponent.kind === "number" && Math.abs(exponent.value) > CUSTOM_LIMITS.maxFormulaExponent) {
        throw new FormulaError(`指数超过 ${CUSTOM_LIMITS.maxFormulaExponent}`);
      }
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private parseUnary(depth: number): FormulaAst {
    const token = this.peek();
    if (token?.kind === "op" && token.text === "-") {
      this.take();
      return { kind: "unary", op: "-", arg: this.parseUnary(depth + 1) };
    }
    if (token?.kind === "op" && token.text === "+") {
      this.take();
      return this.parseUnary(depth + 1);
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): FormulaAst {
    const token = this.take();
    if (token.kind === "number") {
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new FormulaError(`非法数字 ${token.text}`);
      return { kind: "number", value };
    }
    if (token.kind === "lparen") {
      const inner = this.parseExpression(depth + 1);
      const close = this.take();
      if (close.kind !== "rparen") throw new FormulaError("缺少右括号");
      return inner;
    }
    if (token.kind === "ident") {
      if (this.peek()?.kind === "lparen") {
        if (!(token.text in FUNCTIONS)) throw new FormulaError(`未知函数 ${token.text}`);
        this.take();
        const args: FormulaAst[] = [];
        if (this.peek()?.kind !== "rparen") {
          for (;;) {
            args.push(this.parseExpression(depth + 1));
            if (this.peek()?.kind === "comma") {
              this.take();
              continue;
            }
            break;
          }
        }
        const close = this.take();
        if (close.kind !== "rparen") throw new FormulaError("函数缺少右括号");
        const arity = FUNCTIONS[token.text as FormulaFunctionName];
        const [minArity, maxArity] = Array.isArray(arity) ? arity : [arity, arity];
        if (args.length < minArity || args.length > maxArity) {
          throw new FormulaError(`函数 ${token.text} 参数数量不合法`);
        }
        return { kind: "call", name: token.text as FormulaFunctionName, args };
      }
      const path = [token.text];
      while (this.peek()?.kind === "dot") {
        this.take();
        const part = this.take();
        if (part.kind !== "ident") throw new FormulaError("属性路径非法");
        path.push(part.text);
      }
      return { kind: "path", path };
    }
    throw new FormulaError(`公式在 "${token.text}" 处无法解析`);
  }
}

export interface CompiledFormula {
  source: string;
  ast: FormulaAst;
}

export function compileFormula(source: string): CompiledFormula {
  if (typeof source !== "string" || source.trim() === "") throw new FormulaError("公式不能为空");
  if (source.length > 512) throw new FormulaError("公式文本过长");
  if (/eval|Function|prototype|__proto__|constructor/i.test(source)) {
    throw new FormulaError("公式包含禁止的关键字");
  }
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();
  if ((parser as unknown as { pos: number }).pos !== tokens.length) {
    throw new FormulaError("公式末尾存在多余内容");
  }
  return { source, ast };
}

export function tryCompileFormula(value: unknown): CompiledFormula | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FormulaError("数值公式必须是有限数");
    return { source: String(value), ast: { kind: "number", value } };
  }
  if (typeof value === "string") return compileFormula(value);
  return undefined;
}

function asNumber(value: FormulaValue | undefined, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FormulaError(`公式 ${source} 的结果不是有限数字`);
  }
  return value;
}

export function evaluateFormula(compiled: CompiledFormula, scope: FormulaScope): FormulaValue {
  const evalNode = (node: FormulaAst, depth: number): FormulaValue => {
    if (depth > CUSTOM_LIMITS.maxFormulaAstDepth * 4) throw new FormulaError("公式求值深度超限");
    switch (node.kind) {
      case "number":
        return node.value;
      case "path": {
        const value = scope.resolvePath(node.path);
        if (value === undefined) throw new FormulaError(`未知变量 ${node.path.join(".")}`);
        return value;
      }
      case "unary":
        return -asNumber(evalNode(node.arg, depth + 1), compiled.source);
      case "binary": {
        const left = asNumber(evalNode(node.left, depth + 1), compiled.source);
        const right = asNumber(evalNode(node.right, depth + 1), compiled.source);
        let out: number;
        if (node.op === "+") out = left + right;
        else if (node.op === "-") out = left - right;
        else if (node.op === "*") out = left * right;
        else if (node.op === "/") {
          if (right === 0) throw new FormulaError("除零错误");
          out = left / right;
        } else {
          if (Math.abs(right) > CUSTOM_LIMITS.maxFormulaExponent) throw new FormulaError("指数过大");
          out = Math.pow(left, right);
        }
        if (!Number.isFinite(out)) throw new FormulaError("公式结果溢出");
        if (Math.abs(out) > CUSTOM_LIMITS.maxFormulaAbsValue) throw new FormulaError("公式结果超出允许范围");
        return out;
      }
      case "compare": {
        const left = evalNode(node.left, depth + 1);
        const right = evalNode(node.right, depth + 1);
        if (node.op === "==") return left === right;
        if (node.op === "!=") return left !== right;
        const ln = asNumber(left, compiled.source);
        const rn = asNumber(right, compiled.source);
        if (node.op === "<") return ln < rn;
        if (node.op === "<=") return ln <= rn;
        if (node.op === ">") return ln > rn;
        return ln >= rn;
      }
      case "call": {
        const args = node.args.map((arg) => evalNode(arg, depth + 1));
        if (node.name === "next") {
          const viaScope = scope.callFunction?.("next", args);
          if (viaScope === undefined) throw new FormulaError("当前上下文不支持 next()");
          return viaScope;
        }
        const nums = args.map((arg) => asNumber(arg, compiled.source));
        if (node.name === "ceil") return Math.ceil(nums[0]);
        if (node.name === "floor") return Math.floor(nums[0]);
        if (node.name === "round") return Math.round(nums[0]);
        if (node.name === "abs") return Math.abs(nums[0]);
        if (node.name === "min") return Math.min(...nums);
        return Math.max(...nums);
      }
    }
  };
  return evalNode(compiled.ast, 0);
}

export function evaluateFormulaNumber(compiled: CompiledFormula, scope: FormulaScope): number {
  return asNumber(evaluateFormula(compiled, scope), compiled.source);
}

export function evaluateFormulaCount(compiled: CompiledFormula, scope: FormulaScope, maximum = CUSTOM_LIMITS.maxDynamicDraw): number {
  const value = evaluateFormulaNumber(compiled, scope);
  if (value < 0) throw new FormulaError("计数公式不能为负数");
  if (value > maximum) throw new FormulaError(`计数公式结果超过 ${maximum}`);
  return Math.floor(value);
}

export function evaluateFormulaBoolean(compiled: CompiledFormula, scope: FormulaScope): boolean {
  const value = evaluateFormula(compiled, scope);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  throw new FormulaError("条件公式结果不是布尔值");
}
