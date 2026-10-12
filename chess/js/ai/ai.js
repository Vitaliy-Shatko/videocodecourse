/**
 * Chess AI: iterative-deepening negamax with alpha-beta pruning, quiescence
 * search, MVV-LVA + killer move ordering and a material + piece-square-table
 * evaluation with a tapered king table for the endgame.
 *
 * Works on the engine's internal 0x88 representation and uses the fast
 * _generatePseudoLegal/_make/_unmake path (legality verified inline), so no
 * public API objects are allocated inside the search.
 */
import {
  Chess, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
  typeOf, colorOf, fileOf, rankOf, squareToName, FLAG_CAPTURE, FLAG_PROMOTION,
} from '../engine/chess.js';

export const MATE_SCORE = 100000;
const INFINITY = 1000000;

// Material values in centipawns.
export const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 20000];

// Piece-square tables, from White's point of view, a8 first (row 0 = rank 8).
// Adapted from the classic "Simplified Evaluation Function" (chessprogramming.org).
const PST_PAWN = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const PST_KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
const PST_BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
const PST_ROOK = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];
const PST_QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
const PST_KING_MIDDLE = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
const PST_KING_END = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

// Pre-expand the tables to 0x88 indices for both colors: PST[piece][square].
const PST = (() => {
  const tables = { [PAWN]: PST_PAWN, [KNIGHT]: PST_KNIGHT, [BISHOP]: PST_BISHOP, [ROOK]: PST_ROOK, [QUEEN]: PST_QUEEN, [KING]: PST_KING_MIDDLE };
  const out = [];
  for (let piece = 0; piece < 16; piece++) out.push(new Int16Array(128));
  const kingEnd = { [WHITE]: new Int16Array(128), [BLACK]: new Int16Array(128) };
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const file = fileOf(sq), rank = rankOf(sq);
    const whiteIdx = (7 - rank) * 8 + file;
    const blackIdx = rank * 8 + file;
    for (const [type, table] of Object.entries(tables)) {
      out[Number(type) | WHITE][sq] = table[whiteIdx];
      out[Number(type) | BLACK][sq] = table[blackIdx];
    }
    kingEnd[WHITE][sq] = PST_KING_END[whiteIdx];
    kingEnd[BLACK][sq] = PST_KING_END[blackIdx];
  }
  out.kingEnd = kingEnd;
  return out;
})();

/**
 * Static evaluation from the side-to-move's point of view (centipawns).
 */
export function evaluate(chess) {
  const { board, turn } = chess.internal;
  let white = 0, black = 0;
  let nonPawnMaterial = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whiteKing = -1, blackKing = -1;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = board[sq];
    if (p === EMPTY) continue;
    const type = typeOf(p);
    if (type === KING) {
      if (colorOf(p) === WHITE) whiteKing = sq; else blackKing = sq;
      continue;
    }
    const value = PIECE_VALUE[type] + PST[p][sq];
    if (colorOf(p) === WHITE) {
      white += value;
      if (type === BISHOP) whiteBishops++;
    } else {
      black += value;
      if (type === BISHOP) blackBishops++;
    }
    if (type !== PAWN) nonPawnMaterial += PIECE_VALUE[type];
  }

  // Endgame when little non-pawn material remains (roughly a queen + rook in total).
  const endgame = nonPawnMaterial <= 1500;
  if (whiteKing !== -1) white += endgame ? PST.kingEnd[WHITE][whiteKing] : PST[KING | WHITE][whiteKing];
  if (blackKing !== -1) black += endgame ? PST.kingEnd[BLACK][blackKing] : PST[KING | BLACK][blackKing];
  if (whiteBishops >= 2) white += 30;
  if (blackBishops >= 2) black += 30;

  const score = white - black;
  return turn === WHITE ? score : -score;
}

/**
 * Move ordering score: hash/PV move first, then captures (MVV-LVA),
 * promotions, killers, then quiet moves.
 */
function scoreMove(m, pvMove, killers) {
  if (pvMove && m.from === pvMove.from && m.to === pvMove.to && m.promotion === pvMove.promotion) return 1000000;
  let s = 0;
  if (m.flags & FLAG_CAPTURE) {
    s += 100000 + PIECE_VALUE[typeOf(m.captured)] * 10 - PIECE_VALUE[typeOf(m.piece)] / 100;
  }
  if (m.flags & FLAG_PROMOTION) s += 90000 + PIECE_VALUE[m.promotion];
  if (!s && killers) {
    if (sameMove(m, killers[0])) s = 80000;
    else if (sameMove(m, killers[1])) s = 70000;
  }
  return s;
}

function sameMove(a, b) {
  return !!b && a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

export class SearchAborted extends Error {}

/**
 * Searches the position and returns the best move.
 *
 * @param {Chess} chess            game (will be left unchanged)
 * @param {object} options
 * @param {number} options.maxDepth  maximum iterative deepening depth (plies)
 * @param {number} options.timeMs    soft time limit in milliseconds
 * @param {number} options.randomness centipawn noise added to root scores (0 = deterministic)
 * @param {function} options.onProgress called after each completed depth
 * @returns {{move, score, depth, nodes, pv, timeMs}|null} null when no legal moves
 */
export function findBestMove(chess, { maxDepth = 4, timeMs = 3000, randomness = 0, onProgress } = {}) {
  const start = Date.now();
  const deadline = start + timeMs;
  const killers = [];
  for (let i = 0; i < 64; i++) killers.push([null, null]);
  let nodes = 0;
  let aborted = false;

  const us = chess.internal.turn;
  const baseLength = chess.historyLength();
  const rootMoves = chess._generateLegal().slice();
  if (rootMoves.length === 0) return null;
  if (rootMoves.length === 1) {
    return { move: toPublic(chess, rootMoves[0]), score: 0, depth: 0, nodes: 1, pv: [], timeMs: 0 };
  }

  const checkTime = () => {
    if ((nodes & 2047) === 0 && Date.now() > deadline) {
      aborted = true;
      throw new SearchAborted();
    }
  };

  const quiescence = (alpha, beta, ply) => {
    nodes++;
    checkTime();
    const standPat = evaluate(chess);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    const moves = chess._generatePseudoLegal();
    const captures = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (m.flags & (FLAG_CAPTURE | FLAG_PROMOTION)) {
        m._score = scoreMove(m, null, null);
        captures.push(m);
      }
    }
    captures.sort((a, b) => b._score - a._score);
    const side = chess.internal.turn;
    for (let i = 0; i < captures.length; i++) {
      const m = captures[i];
      chess._make(m);
      if (chess._isKingAttacked(side)) { chess._unmake(); continue; }
      const score = -quiescence(-beta, -alpha, ply + 1);
      chess._unmake();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  const negamax = (depth, alpha, beta, ply, pvMove) => {
    nodes++;
    checkTime();

    // Draw detection inside the search: repetition or fifty-move rule.
    if (ply > 0 && (chess._repetitionCount() >= 2 || chess.internal.halfMoves >= 100)) return 0;

    if (depth <= 0) return quiescence(alpha, beta, ply);

    const side = chess.internal.turn;
    const inCheck = chess._isKingAttacked(side);
    if (inCheck) depth++; // check extension

    const moves = chess._generatePseudoLegal();
    for (let i = 0; i < moves.length; i++) moves[i]._score = scoreMove(moves[i], pvMove, killers[ply]);
    moves.sort((a, b) => b._score - a._score);

    let bestScore = -INFINITY;
    let legalMoves = 0;
    let bestLine = null;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      chess._make(m);
      if (chess._isKingAttacked(side)) { chess._unmake(); continue; }
      legalMoves++;
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1, null);
      chess._unmake();

      if (score > bestScore) {
        bestScore = score;
        bestLine = m;
      }
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) {
          if (!(m.flags & FLAG_CAPTURE)) {
            const k = killers[ply];
            if (!sameMove(m, k[0])) { k[1] = k[0]; k[0] = m; }
          }
          break;
        }
      }
    }

    if (legalMoves === 0) return inCheck ? -MATE_SCORE + ply : 0;
    return bestScore;
  };

  let best = null;
  let bestScore = 0;
  let completedDepth = 0;
  const rng = mulberry32(Date.now() & 0xffffffff);

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -INFINITY;
    let iterationBest = null;
    let iterationBestScore = -INFINITY;

    // Order root moves: previous best first, then by last iteration's score.
    for (const m of rootMoves) m._score = scoreMove(m, best, null) + (m._rootScore || 0) / 10;
    rootMoves.sort((a, b) => b._score - a._score);

    try {
      for (const m of rootMoves) {
        chess._make(m);
        let score = -negamax(depth - 1, -INFINITY, -alpha, 1, null);
        chess._unmake();
        if (randomness > 0) score += (rng() - 0.5) * 2 * randomness;
        m._rootScore = score;
        if (score > iterationBestScore) {
          iterationBestScore = score;
          iterationBest = m;
        }
        if (score > alpha) alpha = score;
      }
    } catch (e) {
      if (!(e instanceof SearchAborted)) throw e;
      // Unwind whatever the aborted recursion still had on the stack.
      while (chess.historyLength() > baseLength) chess._unmake();
    }

    if (aborted) {
      // Root moves are ordered with the previous best first, so every fully searched move of
      // the partial iteration was compared against it: its best is at least as good a choice.
      if (iterationBest) { best = iterationBest; bestScore = iterationBestScore; }
      break;
    }

    best = iterationBest;
    bestScore = iterationBestScore;
    completedDepth = depth;
    if (onProgress) {
      onProgress({ depth, score: scoreFor(bestScore, us), nodes, move: toPublic(chess, best), timeMs: Date.now() - start });
    }
    // Mate found: no need to search deeper.
    if (Math.abs(bestScore) > MATE_SCORE - 100) break;
    // Not enough time left for another (roughly 4x more expensive) iteration.
    if (Date.now() - start > timeMs / 4) break;
  }

  return {
    move: toPublic(chess, best || rootMoves[0]),
    score: scoreFor(bestScore, us),
    depth: completedDepth,
    nodes,
    timeMs: Date.now() - start,
  };
}

/** Score in centipawns from White's perspective (what UIs usually display). */
function scoreFor(score, sideToMove) {
  return sideToMove === WHITE ? score : -score;
}

function toPublic(chess, m) {
  if (!m) return null;
  return {
    from: squareToName(m.from),
    to: squareToName(m.to),
    promotion: m.promotion ? 'pnbrqk'[m.promotion - 1] : undefined,
  };
}

function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Difficulty presets used by the UI. */
export const LEVELS = {
  1: { label: 'Новичок', maxDepth: 1, timeMs: 300, randomness: 150 },
  2: { label: 'Любитель', maxDepth: 2, timeMs: 800, randomness: 40 },
  3: { label: 'Клубный', maxDepth: 3, timeMs: 1500, randomness: 0 },
  4: { label: 'Сильный', maxDepth: 5, timeMs: 3000, randomness: 0 },
  5: { label: 'Мастер', maxDepth: 8, timeMs: 6000, randomness: 0 },
};

/** Convenience: run a search for a FEN string (used by the worker). */
export function searchFen(fen, options) {
  const chess = new Chess(fen);
  return findBestMove(chess, options);
}
