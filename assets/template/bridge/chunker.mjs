// Markdown 长文本切分器。
//
// QQ 单条消息有长度上限（约 5000 字符），出站回复按 ~4500 字符切分：
// - 优先在空行（段落边界）处断开；
// - 绝不在 ``` 代码块中间断开（代码块整体进同一 chunk），
//   除非代码块本身超过上限，才在块内按行硬切并补齐围栏；
// - 单行超过上限时按字符硬切。
//
// 纯函数，无副作用，供 daemon 与 smoke-test 共用。

const FENCE = /^```/;

function splitBlocks(text) {
  // 把文本拆成「块」：普通段落（以空行分隔）与完整代码块各成一块。
  const lines = text.split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  const flush = () => {
    if (buf.length > 0) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence) flush(); // 代码块开始前先收普通段落
      inFence = !inFence;
      buf.push(line);
      if (!inFence) flush(); // 代码块闭合，整块成型
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function hardSplit(text, limit) {
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

export function chunkMarkdown(text, limit = 4500) {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  const pushCurrent = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  for (const block of splitBlocks(text)) {
    if (block.length > limit) {
      // 单块超限：先冲掉当前累积，再硬切这一块。
      pushCurrent();
      if (block.startsWith('```')) {
        // 代码块硬切：按行累积，尽量不拆行；每片补上围栏保持可读。
        const lines = block.split('\n');
        let piece = '';
        for (const line of lines) {
          if (piece && piece.length + line.length + 1 > limit - 8) {
            chunks.push(piece.endsWith('```') ? piece : piece + '\n```');
            piece = '```\n' + line;
          } else {
            piece = piece ? piece + '\n' + line : line;
          }
        }
        if (piece) chunks.push(piece);
      } else {
        chunks.push(...hardSplit(block, limit));
      }
      continue;
    }
    const candidate = current ? current + '\n\n' + block : block;
    if (candidate.length > limit) {
      pushCurrent();
      current = block;
    } else {
      current = candidate;
    }
  }
  pushCurrent();
  return chunks;
}

export const DEFAULT_CHUNK_LIMIT = 4500;
