type Scalar = string | number | boolean | null;

type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };

type ParsedLine = {
  indent: number;
  text: string;
};

const OBJECT_KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitInlineItems(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? (char as '"' | "'");
      current += char;
      continue;
    }

    if (char === "," && quote === null) {
      items.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

function parseScalar(raw: string): YamlValue {
  const value = raw.trim();

  if (value === "") return "";
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineItems(inner).map((item) => parseScalar(item));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function preprocess(input: string): ParsedLine[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const normalized = line.replace(/\t/g, "  ");
      const indent = normalized.match(/^ */)?.[0].length ?? 0;
      const text = normalized.slice(indent).trimEnd();
      return { indent, text };
    })
    .filter((line) => line.text !== "" && !line.text.startsWith("#"));
}

class Parser {
  private readonly lines: ParsedLine[];

  private index = 0;

  constructor(lines: ParsedLine[]) {
    this.lines = lines;
  }

  parse(): YamlValue {
    if (this.lines.length === 0) {
      return {};
    }
    return this.parseBlock(this.lines[0].indent);
  }

  private current(): ParsedLine | undefined {
    return this.lines[this.index];
  }

  private parseBlock(indent: number): YamlValue {
    const line = this.current();
    if (!line) return {};
    return line.text.startsWith("- ") ? this.parseArray(indent) : this.parseObject(indent);
  }

  private parseObject(indent: number): Record<string, YamlValue> {
    const result: Record<string, YamlValue> = {};

    while (this.index < this.lines.length) {
      const line = this.current();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation on line ${this.index + 1}`);
      }
      if (line.text.startsWith("- ")) break;

      const match = line.text.match(OBJECT_KEY_RE);
      if (!match) {
        throw new Error(`Invalid mapping entry on line ${this.index + 1}: ${line.text}`);
      }

      const [, key, rawValue] = match;
      const valueText = rawValue.trim();
      this.index += 1;

      if (valueText === "") {
        const next = this.current();
        if (!next || next.indent <= indent) {
          result[key] = null;
        } else {
          result[key] = this.parseBlock(next.indent);
        }
      } else {
        result[key] = parseScalar(valueText);
      }
    }

    return result;
  }

  private parseArray(indent: number): YamlValue[] {
    const result: YamlValue[] = [];

    while (this.index < this.lines.length) {
      const line = this.current();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation on line ${this.index + 1}`);
      }
      if (!line.text.startsWith("- ")) break;

      const valueText = line.text.slice(2).trim();
      this.index += 1;

      if (valueText === "") {
        const next = this.current();
        if (!next || next.indent <= indent) {
          result.push(null);
        } else {
          result.push(this.parseBlock(next.indent));
        }
        continue;
      }

      const match = valueText.match(OBJECT_KEY_RE);
      if (match) {
        const [, key, rawValue] = match;
        const item: Record<string, YamlValue> = {};
        const firstValue = rawValue.trim();

        if (firstValue === "") {
          const next = this.current();
          if (!next || next.indent <= indent + 2) {
            item[key] = null;
          } else {
            item[key] = this.parseBlock(next.indent);
          }
        } else {
          item[key] = parseScalar(firstValue);
        }

        while (this.index < this.lines.length) {
          const next = this.current();
          if (!next || next.indent < indent + 2) break;
          if (next.indent > indent + 2) {
            throw new Error(`Unexpected indentation on line ${this.index + 1}`);
          }
          if (next.text.startsWith("- ")) {
            break;
          }
          Object.assign(item, this.parseObject(indent + 2));
        }

        result.push(item);
        continue;
      }

      result.push(parseScalar(valueText));
    }

    return result;
  }
}

export function parseYaml(input: string): unknown {
  const lines = preprocess(input);
  return new Parser(lines).parse();
}
