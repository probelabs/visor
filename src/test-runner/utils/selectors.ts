export function deepGet(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const parts: Array<string | number> = [];
  let i = 0;

  const readIdent = () => {
    const start = i;
    while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
    if (i > start) parts.push(path.slice(start, i));
  };
  const readBracket = () => {
    // assumes path[i] === '['
    i++; // skip [
    if (i < path.length && (path[i] === '"' || path[i] === "'")) {
      const quote = path[i++];
      const start = i;
      while (i < path.length && path[i] !== quote) i++;
      const key = path.slice(start, i);
      parts.push(key);
      // skip closing quote
      if (i < path.length && path[i] === quote) i++;
      // skip ]
      if (i < path.length && path[i] === ']') i++;
    } else {
      // numeric index
      const start = i;
      while (i < path.length && /[0-9]/.test(path[i])) i++;
      const numStr = path.slice(start, i);
      parts.push(Number(numStr));
      if (i < path.length && path[i] === ']') i++;
    }
  };

  // initial token (identifier or bracket)
  if (path[i] === '[') {
    readBracket();
  } else {
    if (path[i] === '.') i++;
    readIdent();
  }
  while (i < path.length) {
    if (path[i] === '.') {
      i++;
      readIdent();
    } else if (path[i] === '[') {
      readBracket();
    } else {
      // unexpected char, stop parsing
      break;
    }
  }

  let cur: any = obj;
  for (const key of parts) {
    if (cur == null) return undefined;
    cur = cur[key as any];
  }
  return cur;
}
