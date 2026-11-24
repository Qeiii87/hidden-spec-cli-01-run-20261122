// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write with move (`R`) output lines (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as (old, new) pairs, for the `R` output lines (SPEC.md section 2). */
  readonly moves: { old: string; nw: string }[] = [];
  recordMove(old: string, nw: string): void {
    if (!this.moves.some((m) => m.old === old && m.nw === nw)) this.moves.push({ old, nw });
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- lines and files (SPEC.md sections 3 and 5) ----

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line feed follows a carriage return). */
function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function fileText(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || lines.length < k) return out;
  const no = o.map((l) => normLine(l, tier));
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it never occurs. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`, taking the first of them. */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/**
 * The lines N writes for a match of O at position i. A context line is written as the file's own matched
 * line, never the patch's; at tier 2 every other line of N is re-indented (SPEC.md section 5).
 * oCtx/nCtx mark the context lines of O and N; the k-th context line of N is the k-th of O.
 */
function replacementLines(
  fileLines: string[],
  i: number,
  oLines: string[],
  oCtx: boolean[],
  nLines: string[],
  nCtx: boolean[],
  tier: number,
): string[] {
  const oCtxIdx: number[] = [];
  oCtx.forEach((c, idx) => {
    if (c) oCtxIdx.push(idx);
  });
  const f = leadingWS(fileLines[i] ?? '');
  const p = leadingWS(oLines[0] ?? '');
  const out: string[] = [];
  let ctxCount = 0;
  nLines.forEach((line, ni) => {
    if (nCtx[ni]) {
      out.push(fileLines[i + oCtxIdx[ctxCount]!]!);
      ctxCount++;
    } else if (tier === 2) {
      if (line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(line);
    }
  });
  return out;
}

// ---- unified diffs (SPEC.md section 6) ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** The patch line as written; a zero-length line is an empty line, a one-space line is not. */
  raw: string;
}

interface Hunk {
  a: number;
  oLines: string[];
  oCtx: boolean[];
  nLines: string[];
  nCtx: boolean[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
}

interface Section {
  /** Paths from the `diff --git` line, the `rename from/to` lines and the `---`/`+++` pair, in
   * increasing precedence: the pair names the paths when it exists, else the rename lines, else
   * the `diff --git` paths (SPEC.md section 6). */
  gitOld: string | null;
  gitNew: string | null;
  renOld: string | null;
  renNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function gitPath(p: string): string | null {
  if (p === '/dev/null') return null;
  return p;
}

function parseHunkBody(raw: BodyLine[]): Hunk | null {
  // Empty lines at the end of a body are not part of it (a one-space line is a context line, not empty).
  const body = [...raw];
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  const oLines: string[] = [];
  const oCtx: boolean[] = [];
  const nLines: string[] = [];
  const nCtx: boolean[] = [];
  let noNL = false;
  let lastCtxOrNew = -1;
  body.forEach((b, idx) => {
    if (b.kind === 'ctx') {
      oLines.push(b.text);
      oCtx.push(true);
      nLines.push(b.text);
      nCtx.push(true);
      lastCtxOrNew = idx;
    } else if (b.kind === 'old') {
      oLines.push(b.text);
      oCtx.push(false);
    } else if (b.kind === 'new') {
      nLines.push(b.text);
      nCtx.push(false);
      lastCtxOrNew = idx;
    }
  });
  if (lastCtxOrNew >= 0 && body[lastCtxOrNew + 1]?.kind === 'bs') noNL = true;
  return { a: 0, oLines, oCtx, nLines, nCtx, noNL };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (): Section => {
    const s: Section = {
      gitOld: null,
      gitNew: null,
      renOld: null,
      renNew: null,
      dashOld: null,
      dashNew: null,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = gitPath(m[1]!);
      s.gitNew = gitPath(m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && cur) {
        // Already part of a section's header: it names the paths, it does not start a section.
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const s = startSection();
      s.dashOld = dashPath(line);
      s.dashNew = dashPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      inHeader = false;
      i++;
      const raw: BodyLine[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '') {
          raw.push({ kind: 'ctx', text: '', raw: l });
          i++;
        } else if (l[0] === ' ') {
          raw.push({ kind: 'ctx', text: l.slice(1), raw: l });
          i++;
        } else if (l[0] === '-') {
          raw.push({ kind: 'old', text: l.slice(1), raw: l });
          i++;
        } else if (l[0] === '+') {
          raw.push({ kind: 'new', text: l.slice(1), raw: l });
          i++;
        } else if (l[0] === '\\') {
          raw.push({ kind: 'bs', text: l.slice(1), raw: l });
          i++;
        } else break;
      }
      const hunk = parseHunkBody(raw)!;
      hunk.a = a;
      cur.hunks.push(hunk);
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.dashOld = dashPath(line);
          cur.dashNew = dashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        if (cur.renOld === '/dev/null') cur.renOld = null;
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        if (cur.renNew === '/dev/null') cur.renNew = null;
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i++;
  }
  return sections.map((sec) => {
    const oldPath = sec.dashOld ?? sec.renOld ?? sec.gitOld;
    const newPath = sec.dashNew ?? sec.renNew ?? sec.gitNew;
    return unifiedSectionEdit({ oldPath, newPath, create: sec.create, del: sec.del, hunks: sec.hunks }, strict);
  });
}

function unifiedSectionEdit(
  sec: { oldPath: string | null; newPath: string | null; create: boolean; del: boolean; hunks: Hunk[] },
  strict: boolean,
): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.del);
    if (isCreate) {
      const p = newP;
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        h.nLines.forEach((l, ni) => {
          if (!h.nCtx[ni]) plus.push(l);
        });
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line:
      // the file's last `+` line is the last `+` line of the last hunk that has one, and a `\`
      // line follows it exactly when it is that hunk's last context-or-new line and the hunk's
      // noNL flag is set (a context line after it would take the `\` line instead).
      let endsWithBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let lastPlusIdx = -1;
        for (let ni = h.nLines.length - 1; ni >= 0; ni--) {
          if (!h.nCtx[ni]) {
            lastPlusIdx = ni;
            break;
          }
        }
        if (lastPlusIdx < 0) continue;
        const ctxAfter = h.nCtx.slice(lastPlusIdx + 1).some((c) => c);
        if (!ctxAfter && h.noNL) endsWithBreak = false;
        break;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== newP;
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (isMove) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    }
    let state = fileState(cur);
    let d = 0;
    for (const hunk of sec.hunks) {
      state = applyHunk(state, hunk, d, strict, p);
      d += hunk.nLines.length - hunk.oLines.length;
    }
    const text = fileText(state);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      tree.recordMove(p, newP!);
    } else {
      tree.now.set(p, text);
    }
  };
}

/** Apply one hunk to a file's lines; d is the drift of earlier hunks of this section. */
function applyHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const lines = state.lines;
  const o = hunk.oLines;
  const n = hunk.nLines;
  if (o.length === 0) {
    const at = Math.min(hunk.a + d, lines.length);
    const nl = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    const final = at === lines.length ? !hunk.noNL : state.final;
    return { lines: nl, br: state.br, final };
  }
  const found = findTier(lines, o, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = replacementLines(lines, best, o, hunk.oCtx, n, hunk.nCtx, found.tier);
  const nl = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  const runsToEnd = best + o.length === lines.length;
  const final = runsToEnd ? !hunk.noNL : state.final;
  return { lines: nl, br: state.br, final };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const state = fileState(cur);
    const found = findTier(state.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const rep = replacementLines(
      state.lines,
      at,
      oldLines,
      oldLines.map(() => false),
      newLines,
      newLines.map(() => false),
      found.tier,
    );
    const nl = [...state.lines.slice(0, at), ...rep, ...state.lines.slice(at + oldLines.length)];
    tree.now.set(path, fileText({ lines: nl, br: state.br, final: state.final }));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oLines: string[];
  oCtx: boolean[];
  nLines: string[];
  nCtx: boolean[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i++;
    const secLines: { text: string; num: number }[] = [];
    while (i < end) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      secLines.push({ text: t, num: i + 1 });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(v4aSectionEdit(kind, path, secLines, secLine, strict));
  }
  return edits;
}

function v4aSectionEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  secLines: { text: string; num: number }[],
  secLine: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, num } of secLines) {
      if (text === '') fileLines.push('');
      else if (text.startsWith('+')) fileLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const { text, num } of secLines) {
      if (!blank(text)) throw new Exit2(`error: parse ${num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update: optional `*** Move to:` first, then chunks.
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < secLines.length && secLines[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: V4aChunk[] = [];
  let chunk: V4aChunk | null = null;
  let sawChunk = false;
  const closeChunk = (): void => {
    chunk = null;
  };
  while (idx < secLines.length) {
    const { text, num } = secLines[idx]!;
    if (text.startsWith('@@')) {
      const anchorText = text.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, oLines: [], oCtx: [], nLines: [], nCtx: [] };
      chunks.push(chunk);
      sawChunk = true;
      idx++;
      continue;
    }
    if (text === '*** End of File') {
      if (!chunk) throw new Exit2(`error: parse ${num}`);
      chunk.eof = true;
      closeChunk();
      idx++;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (!chunk) {
        if (sawChunk) throw new Exit2(`error: parse ${num}`);
        chunk = { anchor: null, eof: false, oLines: [], oCtx: [], nLines: [], nCtx: [] };
        chunks.push(chunk);
        sawChunk = true;
      }
      if (text === '') {
        chunk.oLines.push('');
        chunk.oCtx.push(true);
        chunk.nLines.push('');
        chunk.nCtx.push(true);
      } else if (text[0] === ' ') {
        chunk.oLines.push(text.slice(1));
        chunk.oCtx.push(true);
        chunk.nLines.push(text.slice(1));
        chunk.nCtx.push(true);
      } else if (text[0] === '-') {
        chunk.oLines.push(text.slice(1));
        chunk.oCtx.push(false);
      } else {
        chunk.nLines.push(text.slice(1));
        chunk.nCtx.push(false);
      }
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = fileState(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const na = normLine(ch.anchor, tier);
          for (let j = cursor; j < state.lines.length; j++) {
            if (normLine(state.lines[j]!, tier) === na) {
              foundAt = j;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.oLines.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const nl = [...state.lines.slice(0, at), ...ch.nLines, ...state.lines.slice(at)];
        cursor = at + ch.nLines.length;
        state = { lines: nl, br: state.br, final: state.final };
      } else {
        const found = findTierFrom(state.lines, ch.oLines, cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const rep = replacementLines(state.lines, found.pos, ch.oLines, ch.oCtx, ch.nLines, ch.nCtx, found.tier);
        const nl = [...state.lines.slice(0, found.pos), ...rep, ...state.lines.slice(found.pos + ch.oLines.length)];
        cursor = found.pos + rep.length;
        state = { lines: nl, br: state.br, final: state.final };
      }
    }
    const text = fileText(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // A move prints `R <old> -> <new>` in place of that pair's `D` and `A` lines, sorting by <new>:
  // the old path existed before the patch and does not after it, the new path did not exist
  // before it and does after it.
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const moves = tree.moves.filter(
    (m) => tree.original(m.old) !== null && finalOf(m.old) === null && tree.original(m.nw) === null && finalOf(m.nw) !== null,
  );
  const movedOld = new Set(moves.map((m) => m.old));
  const movedNew = new Set(moves.map((m) => m.nw));
  const rows: { key: string; line: string }[] = moves.map((m) => ({ key: m.nw, line: `R ${m.old} -> ${m.nw}` }));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
