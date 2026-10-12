/**
 * Chess rules engine.
 *
 * Pure JavaScript, no DOM access, no dependencies. Can be used in the browser,
 * inside a Web Worker and in Node.js (tests).
 *
 * Board representation: 0x88 (8x16 array). Square index = rank * 16 + file,
 * a1 = 0, h1 = 7, a8 = 112, h8 = 119. A square is on the board iff
 * (index & 0x88) === 0. Piece codes: type in the low 3 bits, color in bit 3.
 */

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const WHITE = 0;
export const BLACK = 8;

export const typeOf = (piece) => piece & 7;
export const colorOf = (piece) => piece & 8;
export const opposite = (color) => color ^ 8;

export const fileOf = (square) => square & 7;
export const rankOf = (square) => square >> 4;
export const makeSquare = (file, rank) => (rank << 4) | file;
export const isOnBoard = (square) => (square & 0x88) === 0;

const FILES = 'abcdefgh';

export function squareToName(square) {
  return FILES[fileOf(square)] + (rankOf(square) + 1);
}

export function nameToSquare(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const file = FILES.indexOf(name[0]);
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || rank < 0 || rank > 7) return -1;
  return makeSquare(file, rank);
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_FROM_CHAR = {
  p: PAWN | BLACK, n: KNIGHT | BLACK, b: BISHOP | BLACK, r: ROOK | BLACK, q: QUEEN | BLACK, k: KING | BLACK,
  P: PAWN | WHITE, N: KNIGHT | WHITE, B: BISHOP | WHITE, R: ROOK | WHITE, Q: QUEEN | WHITE, K: KING | WHITE,
};
const TYPE_CHAR = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const SAN_PIECE = ['', '', 'N', 'B', 'R', 'Q', 'K'];

export function pieceToChar(piece) {
  const c = TYPE_CHAR[typeOf(piece)];
  return colorOf(piece) === WHITE ? c.toUpperCase() : c;
}

// Move flags.
export const FLAG_CAPTURE = 1;
export const FLAG_DOUBLE_PAWN = 2;
export const FLAG_EN_PASSANT = 4;
export const FLAG_PROMOTION = 8;
export const FLAG_KSIDE_CASTLE = 16;
export const FLAG_QSIDE_CASTLE = 32;

// Castling rights bits.
export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS = [-17, -15, 15, 17];
const ROOK_OFFSETS = [-16, -1, 1, 16];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

// Castling bookkeeping: moving from / capturing on these squares clears rights.
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[0] &= ~CASTLE_WQ;   // a1
CASTLE_MASK[4] &= ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLE_MASK[7] &= ~CASTLE_WK;   // h1
CASTLE_MASK[112] &= ~CASTLE_BQ; // a8
CASTLE_MASK[116] &= ~(CASTLE_BK | CASTLE_BQ); // e8
CASTLE_MASK[119] &= ~CASTLE_BK; // h8

// --- Zobrist hashing (two independent 32-bit keys, used for repetition detection) ---

function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const ZOBRIST = (() => {
  const rnd = mulberry32(0x9e3779b9);
  const pieces = [];
  for (let p = 0; p < 16; p++) {
    const lo = new Uint32Array(128);
    const hi = new Uint32Array(128);
    for (let s = 0; s < 128; s++) { lo[s] = rnd(); hi[s] = rnd(); }
    pieces.push({ lo, hi });
  }
  const castleLo = new Uint32Array(16); const castleHi = new Uint32Array(16);
  for (let i = 0; i < 16; i++) { castleLo[i] = rnd(); castleHi[i] = rnd(); }
  const epLo = new Uint32Array(8); const epHi = new Uint32Array(8);
  for (let i = 0; i < 8; i++) { epLo[i] = rnd(); epHi[i] = rnd(); }
  return { pieces, castleLo, castleHi, epLo, epHi, sideLo: rnd(), sideHi: rnd() };
})();

/**
 * A chess game: position + move history. API is intentionally close to
 * chess.js so people familiar with it feel at home.
 */
export class Chess {
  constructor(fen = START_FEN) {
    this.load(fen);
  }

  // ------------------------------------------------------------------ setup

  reset() {
    this.load(START_FEN);
  }

  /**
   * Loads a FEN string. Throws on malformed input.
   */
  load(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2) throw new Error('Некорректный FEN: ожидалось минимум 2 поля');
    const [placement, turn, castling = '-', ep = '-', half = '0', full = '1'] = parts;

    const board = new Uint8Array(128);
    const rows = placement.split('/');
    if (rows.length !== 8) throw new Error('Некорректный FEN: должно быть 8 горизонталей');
    let kings = { [WHITE]: -1, [BLACK]: -1 };
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          file += ch.charCodeAt(0) - 48;
        } else {
          const piece = PIECE_FROM_CHAR[ch];
          if (piece === undefined || file > 7) throw new Error(`Некорректный FEN: символ "${ch}"`);
          const sq = makeSquare(file, rank);
          board[sq] = piece;
          if (typeOf(piece) === KING) {
            if (kings[colorOf(piece)] !== -1) throw new Error('Некорректный FEN: более одного короля');
            kings[colorOf(piece)] = sq;
          }
          file++;
        }
      }
      if (file !== 8) throw new Error('Некорректный FEN: неверная длина горизонтали');
    }
    if (kings[WHITE] === -1 || kings[BLACK] === -1) throw new Error('Некорректный FEN: нет короля');
    if (turn !== 'w' && turn !== 'b') throw new Error('Некорректный FEN: очередь хода');

    let rights = 0;
    if (castling !== '-') {
      for (const ch of castling) {
        if (ch === 'K') rights |= CASTLE_WK;
        else if (ch === 'Q') rights |= CASTLE_WQ;
        else if (ch === 'k') rights |= CASTLE_BK;
        else if (ch === 'q') rights |= CASTLE_BQ;
        else throw new Error('Некорректный FEN: права рокировки');
      }
    }
    // Drop rights that are inconsistent with piece placement.
    if (board[4] !== (KING | WHITE)) rights &= ~(CASTLE_WK | CASTLE_WQ);
    if (board[7] !== (ROOK | WHITE)) rights &= ~CASTLE_WK;
    if (board[0] !== (ROOK | WHITE)) rights &= ~CASTLE_WQ;
    if (board[116] !== (KING | BLACK)) rights &= ~(CASTLE_BK | CASTLE_BQ);
    if (board[119] !== (ROOK | BLACK)) rights &= ~CASTLE_BK;
    if (board[112] !== (ROOK | BLACK)) rights &= ~CASTLE_BQ;

    let epSquare = -1;
    if (ep !== '-') {
      epSquare = nameToSquare(ep);
      if (epSquare === -1) throw new Error('Некорректный FEN: поле взятия на проходе');
    }

    this._board = board;
    this._turn = turn === 'w' ? WHITE : BLACK;
    this._castling = rights;
    this._ep = epSquare;
    this._halfMoves = parseInt(half, 10) || 0;
    this._moveNumber = parseInt(full, 10) || 1;
    this._kings = kings;
    this._history = [];
    this._startFen = this.fen();
    this._computeHash();
    this._invalidateCache();

    if (this._isKingAttacked(opposite(this._turn))) {
      throw new Error('Некорректный FEN: король стороны, не имеющей хода, под шахом');
    }
    return this;
  }

  fen() {
    let placement = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this._board[makeSquare(file, rank)];
        if (piece === EMPTY) {
          empty++;
        } else {
          if (empty) { placement += empty; empty = 0; }
          placement += pieceToChar(piece);
        }
      }
      if (empty) placement += empty;
      if (rank > 0) placement += '/';
    }
    let castling = '';
    if (this._castling & CASTLE_WK) castling += 'K';
    if (this._castling & CASTLE_WQ) castling += 'Q';
    if (this._castling & CASTLE_BK) castling += 'k';
    if (this._castling & CASTLE_BQ) castling += 'q';
    const ep = this._ep === -1 ? '-' : squareToName(this._ep);
    return `${placement} ${this._turn === WHITE ? 'w' : 'b'} ${castling || '-'} ${ep} ${this._halfMoves} ${this._moveNumber}`;
  }

  // -------------------------------------------------------------- accessors

  turn() {
    return this._turn === WHITE ? 'w' : 'b';
  }

  /** Piece on a square as {type:'p'..'k', color:'w'|'b'} or null. */
  get(squareName) {
    const sq = nameToSquare(squareName);
    if (sq === -1) return null;
    return pieceObject(this._board[sq]);
  }

  /** 8x8 array, row 0 = rank 8 (as printed), each cell {square, type, color} or null. */
  board() {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
      const row = [];
      for (let file = 0; file < 8; file++) {
        const sq = makeSquare(file, rank);
        const p = this._board[sq];
        row.push(p === EMPTY ? null : { square: squareToName(sq), ...pieceObject(p) });
      }
      rows.push(row);
    }
    return rows;
  }

  moveNumber() {
    return this._moveNumber;
  }

  halfMoves() {
    return this._halfMoves;
  }

  /** Raw internal state for the AI. Treat as read-only. */
  get internal() {
    return {
      board: this._board,
      turn: this._turn,
      castling: this._castling,
      ep: this._ep,
      kings: this._kings,
      hashLo: this._hashLo,
      hashHi: this._hashHi,
      halfMoves: this._halfMoves,
    };
  }

  // -------------------------------------------------------------- hashing

  _computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this._board[sq];
      if (p) { lo ^= ZOBRIST.pieces[p].lo[sq]; hi ^= ZOBRIST.pieces[p].hi[sq]; }
    }
    lo ^= ZOBRIST.castleLo[this._castling]; hi ^= ZOBRIST.castleHi[this._castling];
    if (this._ep !== -1) { lo ^= ZOBRIST.epLo[fileOf(this._ep)]; hi ^= ZOBRIST.epHi[fileOf(this._ep)]; }
    if (this._turn === BLACK) { lo ^= ZOBRIST.sideLo; hi ^= ZOBRIST.sideHi; }
    this._hashLo = lo >>> 0;
    this._hashHi = hi >>> 0;
  }

  _invalidateCache() {
    this._legalCache = null;
  }

  // ------------------------------------------------------ attack detection

  /** Is `square` attacked by any piece of `byColor`? */
  _isAttacked(square, byColor) {
    const board = this._board;

    // Pawns. A white pawn on s attacks s+15 and s+17.
    if (byColor === WHITE) {
      const a = square - 15, b = square - 17;
      if (isOnBoard(a) && board[a] === (PAWN | WHITE)) return true;
      if (isOnBoard(b) && board[b] === (PAWN | WHITE)) return true;
    } else {
      const a = square + 15, b = square + 17;
      if (isOnBoard(a) && board[a] === (PAWN | BLACK)) return true;
      if (isOnBoard(b) && board[b] === (PAWN | BLACK)) return true;
    }

    const knight = KNIGHT | byColor;
    for (let i = 0; i < 8; i++) {
      const s = square + KNIGHT_OFFSETS[i];
      if (isOnBoard(s) && board[s] === knight) return true;
    }

    const king = KING | byColor;
    for (let i = 0; i < 8; i++) {
      const s = square + KING_OFFSETS[i];
      if (isOnBoard(s) && board[s] === king) return true;
    }

    const bishop = BISHOP | byColor, queen = QUEEN | byColor, rook = ROOK | byColor;
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_OFFSETS[i];
      let s = square + d;
      while (isOnBoard(s)) {
        const p = board[s];
        if (p !== EMPTY) {
          if (p === bishop || p === queen) return true;
          break;
        }
        s += d;
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_OFFSETS[i];
      let s = square + d;
      while (isOnBoard(s)) {
        const p = board[s];
        if (p !== EMPTY) {
          if (p === rook || p === queen) return true;
          break;
        }
        s += d;
      }
    }
    return false;
  }

  _isKingAttacked(color) {
    return this._isAttacked(this._kings[color], opposite(color));
  }

  /** Is the given square attacked by the given side? Public helper for UI. */
  isAttacked(squareName, byColor) {
    const sq = nameToSquare(squareName);
    return sq !== -1 && this._isAttacked(sq, byColor === 'w' ? WHITE : BLACK);
  }

  inCheck() {
    return this._isKingAttacked(this._turn);
  }

  // --------------------------------------------------------- move generation

  /**
   * Pseudo-legal move generation (king safety not checked). Returns internal
   * move objects {from, to, piece, captured, promotion, flags}.
   */
  _generatePseudoLegal(onlySquare = -1) {
    const board = this._board;
    const us = this._turn;
    const them = opposite(us);
    const moves = [];

    const add = (from, to, piece, captured, flags, promotion = 0) => {
      moves.push({ from, to, piece, captured, promotion, flags });
    };
    const addPawn = (from, to, piece, captured, flags) => {
      const toRank = rankOf(to);
      if (toRank === 7 || toRank === 0) {
        add(from, to, piece, captured, flags | FLAG_PROMOTION, QUEEN);
        add(from, to, piece, captured, flags | FLAG_PROMOTION, ROOK);
        add(from, to, piece, captured, flags | FLAG_PROMOTION, BISHOP);
        add(from, to, piece, captured, flags | FLAG_PROMOTION, KNIGHT);
      } else {
        add(from, to, piece, captured, flags);
      }
    };

    const first = onlySquare === -1 ? 0 : onlySquare;
    const last = onlySquare === -1 ? 119 : onlySquare;

    for (let from = first; from <= last; from++) {
      if (from & 0x88) { from += 7; continue; }
      const piece = board[from];
      if (piece === EMPTY || colorOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const one = from + dir;
        if (isOnBoard(one) && board[one] === EMPTY) {
          addPawn(from, one, piece, EMPTY, 0);
          const two = one + dir;
          if (rankOf(from) === startRank && board[two] === EMPTY) {
            add(from, two, piece, EMPTY, FLAG_DOUBLE_PAWN);
          }
        }
        for (const side of [dir - 1, dir + 1]) {
          const to = from + side;
          if (!isOnBoard(to)) continue;
          const target = board[to];
          if (target !== EMPTY && colorOf(target) === them) {
            addPawn(from, to, piece, target, FLAG_CAPTURE);
          } else if (to === this._ep) {
            add(from, to, piece, PAWN | them, FLAG_CAPTURE | FLAG_EN_PASSANT);
          }
        }
      } else if (type === KNIGHT || type === KING) {
        const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (let i = 0; i < 8; i++) {
          const to = from + offsets[i];
          if (!isOnBoard(to)) continue;
          const target = board[to];
          if (target === EMPTY) add(from, to, piece, EMPTY, 0);
          else if (colorOf(target) === them) add(from, to, piece, target, FLAG_CAPTURE);
        }
      } else {
        const offsets = type === BISHOP ? BISHOP_OFFSETS : type === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
        for (let i = 0; i < offsets.length; i++) {
          const d = offsets[i];
          let to = from + d;
          while (isOnBoard(to)) {
            const target = board[to];
            if (target === EMPTY) {
              add(from, to, piece, EMPTY, 0);
            } else {
              if (colorOf(target) === them) add(from, to, piece, target, FLAG_CAPTURE);
              break;
            }
            to += d;
          }
        }
      }
    }

    // Castling. King must not be in check, must not pass through or land on an
    // attacked square, and squares between king and rook must be empty.
    const kingSq = this._kings[us];
    if ((onlySquare === -1 || onlySquare === kingSq) && board[kingSq] === (KING | us)) {
      const kRight = us === WHITE ? CASTLE_WK : CASTLE_BK;
      const qRight = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
      if ((this._castling & (kRight | qRight)) && !this._isAttacked(kingSq, them)) {
        if (this._castling & kRight) {
          if (board[kingSq + 1] === EMPTY && board[kingSq + 2] === EMPTY &&
              !this._isAttacked(kingSq + 1, them) && !this._isAttacked(kingSq + 2, them)) {
            add(kingSq, kingSq + 2, KING | us, EMPTY, FLAG_KSIDE_CASTLE);
          }
        }
        if (this._castling & qRight) {
          if (board[kingSq - 1] === EMPTY && board[kingSq - 2] === EMPTY && board[kingSq - 3] === EMPTY &&
              !this._isAttacked(kingSq - 1, them) && !this._isAttacked(kingSq - 2, them)) {
            add(kingSq, kingSq - 2, KING | us, EMPTY, FLAG_QSIDE_CASTLE);
          }
        }
      }
    }

    return moves;
  }

  /** Strictly legal internal moves (king safety verified via make/unmake). */
  _generateLegal(onlySquare = -1) {
    if (onlySquare === -1 && this._legalCache) return this._legalCache;
    const pseudo = this._generatePseudoLegal(onlySquare);
    const legal = [];
    const us = this._turn;
    for (let i = 0; i < pseudo.length; i++) {
      const m = pseudo[i];
      this._make(m);
      if (!this._isKingAttacked(us)) legal.push(m);
      this._unmake();
    }
    if (onlySquare === -1) this._legalCache = legal;
    return legal;
  }

  /**
   * Public move list. Options: { square?: 'e2', verbose?: boolean }.
   * Returns SAN strings by default, detailed move objects when verbose.
   */
  moves({ square, verbose = false } = {}) {
    let legal;
    if (square !== undefined) {
      const sq = nameToSquare(square);
      if (sq === -1) return [];
      legal = this._generateLegal(sq);
    } else {
      legal = this._generateLegal();
    }
    return verbose ? legal.map((m) => this._toVerbose(m)) : legal.map((m) => this._toSan(m));
  }

  // ------------------------------------------------------------ make / unmake

  /** Applies an internal move. No legality check. */
  _make(m) {
    const board = this._board;
    const us = this._turn;
    const them = opposite(us);
    const Z = ZOBRIST;

    this._history.push({
      move: m,
      castling: this._castling,
      ep: this._ep,
      halfMoves: this._halfMoves,
      hashLo: this._hashLo,
      hashHi: this._hashHi,
    });

    let lo = this._hashLo, hi = this._hashHi;

    // Remove old ep / castling from hash.
    if (this._ep !== -1) { lo ^= Z.epLo[fileOf(this._ep)]; hi ^= Z.epHi[fileOf(this._ep)]; }
    lo ^= Z.castleLo[this._castling]; hi ^= Z.castleHi[this._castling];

    // Captured piece.
    if (m.flags & FLAG_EN_PASSANT) {
      const capSq = m.to + (us === WHITE ? -16 : 16);
      lo ^= Z.pieces[board[capSq]].lo[capSq]; hi ^= Z.pieces[board[capSq]].hi[capSq];
      board[capSq] = EMPTY;
    } else if (m.captured) {
      lo ^= Z.pieces[m.captured].lo[m.to]; hi ^= Z.pieces[m.captured].hi[m.to];
    }

    // Move the piece.
    lo ^= Z.pieces[m.piece].lo[m.from]; hi ^= Z.pieces[m.piece].hi[m.from];
    board[m.from] = EMPTY;
    const placed = m.promotion ? (m.promotion | us) : m.piece;
    board[m.to] = placed;
    lo ^= Z.pieces[placed].lo[m.to]; hi ^= Z.pieces[placed].hi[m.to];

    if (typeOf(m.piece) === KING) {
      this._kings[us] = m.to;
      if (m.flags & FLAG_KSIDE_CASTLE) {
        const rookFrom = m.to + 1, rookTo = m.to - 1, rook = ROOK | us;
        board[rookFrom] = EMPTY; board[rookTo] = rook;
        lo ^= Z.pieces[rook].lo[rookFrom] ^ Z.pieces[rook].lo[rookTo];
        hi ^= Z.pieces[rook].hi[rookFrom] ^ Z.pieces[rook].hi[rookTo];
      } else if (m.flags & FLAG_QSIDE_CASTLE) {
        const rookFrom = m.to - 2, rookTo = m.to + 1, rook = ROOK | us;
        board[rookFrom] = EMPTY; board[rookTo] = rook;
        lo ^= Z.pieces[rook].lo[rookFrom] ^ Z.pieces[rook].lo[rookTo];
        hi ^= Z.pieces[rook].hi[rookFrom] ^ Z.pieces[rook].hi[rookTo];
      }
    }

    // Castling rights.
    this._castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
    lo ^= Z.castleLo[this._castling]; hi ^= Z.castleHi[this._castling];

    // En passant square.
    if (m.flags & FLAG_DOUBLE_PAWN) {
      this._ep = m.from + (us === WHITE ? 16 : -16);
      lo ^= Z.epLo[fileOf(this._ep)]; hi ^= Z.epHi[fileOf(this._ep)];
    } else {
      this._ep = -1;
    }

    // Clocks.
    if (typeOf(m.piece) === PAWN || (m.flags & FLAG_CAPTURE)) this._halfMoves = 0;
    else this._halfMoves++;
    if (us === BLACK) this._moveNumber++;

    this._turn = them;
    lo ^= Z.sideLo; hi ^= Z.sideHi;
    this._hashLo = lo >>> 0;
    this._hashHi = hi >>> 0;
    this._invalidateCache();
  }

  /** Reverts the last move made with _make(). */
  _unmake() {
    const entry = this._history.pop();
    if (!entry) return null;
    const m = entry.move;
    const board = this._board;

    this._turn = opposite(this._turn);
    const us = this._turn;
    if (us === BLACK) this._moveNumber--;

    board[m.from] = m.piece;
    board[m.to] = EMPTY;
    if (m.flags & FLAG_EN_PASSANT) {
      board[m.to + (us === WHITE ? -16 : 16)] = m.captured;
    } else if (m.captured) {
      board[m.to] = m.captured;
    }

    if (typeOf(m.piece) === KING) {
      this._kings[us] = m.from;
      if (m.flags & FLAG_KSIDE_CASTLE) {
        board[m.to + 1] = board[m.to - 1]; board[m.to - 1] = EMPTY;
      } else if (m.flags & FLAG_QSIDE_CASTLE) {
        board[m.to - 2] = board[m.to + 1]; board[m.to + 1] = EMPTY;
      }
    }

    this._castling = entry.castling;
    this._ep = entry.ep;
    this._halfMoves = entry.halfMoves;
    this._hashLo = entry.hashLo;
    this._hashHi = entry.hashHi;
    this._invalidateCache();
    return m;
  }

  /**
   * Plays a move. Accepts SAN ("Nf3", "exd5", "O-O", "e8=Q") or an object
   * {from:'e2', to:'e4', promotion?:'q'}. Returns a verbose move object or
   * null if the move is illegal.
   */
  move(input) {
    const m = this._findMove(input);
    if (!m) return null;
    const verbose = this._toVerbose(m);
    this._make(m);
    verbose.after = this.fen();
    return verbose;
  }

  _findMove(input) {
    const legal = this._generateLegal();
    if (typeof input === 'string') {
      const clean = stripSanDecorations(input);
      for (const m of legal) {
        if (stripSanDecorations(this._toSan(m)) === clean) return m;
      }
      // Tolerate long algebraic / UCI style ("e2e4", "e7e8q").
      if (/^[a-h][1-8][a-h][1-8][nbrqNBRQ]?$/.test(clean)) {
        return this._findMove({ from: clean.slice(0, 2), to: clean.slice(2, 4), promotion: clean[4]?.toLowerCase() });
      }
      return null;
    }
    const from = nameToSquare(input.from);
    const to = nameToSquare(input.to);
    const promo = input.promotion ? PIECE_FROM_CHAR[input.promotion.toUpperCase()] & 7 : 0;
    for (const m of legal) {
      if (m.from !== from || m.to !== to) continue;
      if (m.flags & FLAG_PROMOTION) {
        if (m.promotion === (promo || QUEEN)) return m;
      } else {
        return m;
      }
    }
    return null;
  }

  /** Undoes the last move. Returns the verbose move or null. */
  undo() {
    if (this._history.length === 0) return null;
    const m = this._unmake();
    // SAN must be computed in the position *before* the move, i.e. after unmake.
    return this._toVerbose(m);
  }

  /** Move history. Verbose objects or SAN strings. */
  history({ verbose = false } = {}) {
    const replay = new Chess(this._startFen);
    const out = [];
    for (const entry of this._history) {
      const v = replay._toVerbose(entry.move);
      replay._make(entry.move);
      v.after = replay.fen();
      out.push(verbose ? v : v.san);
    }
    return out;
  }

  historyLength() {
    return this._history.length;
  }

  startFen() {
    return this._startFen;
  }

  // ------------------------------------------------------------ game status

  isCheckmate() {
    return this.inCheck() && this._generateLegal().length === 0;
  }

  isStalemate() {
    return !this.inCheck() && this._generateLegal().length === 0;
  }

  /**
   * Insufficient material: K vs K, K+minor vs K, K+B vs K+B with bishops on
   * the same square color (including several bishops all on one color).
   */
  isInsufficientMaterial() {
    const board = this._board;
    let knights = 0, bishopsLight = 0, bishopsDark = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = board[sq];
      if (p === EMPTY) continue;
      const t = typeOf(p);
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT) knights++;
      else if (t === BISHOP) {
        if ((fileOf(sq) + rankOf(sq)) % 2 === 0) bishopsDark++; else bishopsLight++;
      }
    }
    const minors = knights + bishopsLight + bishopsDark;
    if (minors === 0) return true;
    if (minors === 1) return true;
    if (knights === 0 && (bishopsLight === 0 || bishopsDark === 0)) return true;
    return false;
  }

  isFiftyMoves() {
    return this._halfMoves >= 100;
  }

  /** Current position occurred at least three times (including now). */
  isThreefoldRepetition() {
    return this._repetitionCount() >= 3;
  }

  _repetitionCount() {
    let count = 1;
    const lo = this._hashLo, hi = this._hashHi;
    // Only positions since the last irreversible move can repeat.
    const limit = this._history.length - this._halfMoves;
    for (let i = this._history.length - 1; i >= Math.max(0, limit); i--) {
      const h = this._history[i];
      if (h.hashLo === lo && h.hashHi === hi) count++;
    }
    return count;
  }

  isDraw() {
    return this.isStalemate() || this.isInsufficientMaterial() || this.isFiftyMoves() || this.isThreefoldRepetition();
  }

  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  /**
   * Summary: { over, result: '1-0'|'0-1'|'1/2-1/2'|'*', reason, winner: 'w'|'b'|null }.
   */
  status() {
    const legal = this._generateLegal();
    const check = this.inCheck();
    if (legal.length === 0) {
      if (check) {
        const winner = this._turn === WHITE ? 'b' : 'w';
        return { over: true, result: winner === 'w' ? '1-0' : '0-1', reason: 'checkmate', winner, check };
      }
      return { over: true, result: '1/2-1/2', reason: 'stalemate', winner: null, check };
    }
    if (this.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient', winner: null, check };
    if (this.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'repetition', winner: null, check };
    if (this.isFiftyMoves()) return { over: true, result: '1/2-1/2', reason: 'fifty', winner: null, check };
    return { over: false, result: '*', reason: null, winner: null, check };
  }

  // ------------------------------------------------------------- notation

  /** Converts an internal move (for the current position) to a verbose object. */
  _toVerbose(m) {
    const color = colorOf(m.piece) === WHITE ? 'w' : 'b';
    const v = {
      color,
      from: squareToName(m.from),
      to: squareToName(m.to),
      piece: TYPE_CHAR[typeOf(m.piece)],
      flags: m.flags,
      san: this._toSan(m),
    };
    if (m.captured) v.captured = TYPE_CHAR[typeOf(m.captured)];
    if (m.promotion) v.promotion = TYPE_CHAR[m.promotion];
    return v;
  }

  /** Standard Algebraic Notation for an internal move in the current position. */
  _toSan(m) {
    let san;
    if (m.flags & FLAG_KSIDE_CASTLE) {
      san = 'O-O';
    } else if (m.flags & FLAG_QSIDE_CASTLE) {
      san = 'O-O-O';
    } else {
      const type = typeOf(m.piece);
      san = '';
      if (type === PAWN) {
        if (m.flags & FLAG_CAPTURE) san += FILES[fileOf(m.from)];
      } else {
        san += SAN_PIECE[type] + this._disambiguate(m);
      }
      if (m.flags & FLAG_CAPTURE) san += 'x';
      san += squareToName(m.to);
      if (m.promotion) san += '=' + SAN_PIECE[m.promotion];
    }
    // Check / mate suffix.
    this._make(m);
    if (this.inCheck()) san += this._generateLegal().length === 0 ? '#' : '+';
    this._unmake();
    return san;
  }

  _disambiguate(m) {
    const others = this._generateLegal().filter(
      (o) => o.to === m.to && o.from !== m.from && o.piece === m.piece,
    );
    if (others.length === 0) return '';
    const sameFile = others.some((o) => fileOf(o.from) === fileOf(m.from));
    const sameRank = others.some((o) => rankOf(o.from) === rankOf(m.from));
    if (!sameFile) return FILES[fileOf(m.from)];
    if (!sameRank) return String(rankOf(m.from) + 1);
    return squareToName(m.from);
  }

  /** PGN movetext (plus optional headers). */
  pgn({ headers = {}, newline = '\n' } = {}) {
    const lines = [];
    const h = { ...headers };
    if (this._startFen !== START_FEN) {
      h.SetUp = '1';
      h.FEN = this._startFen;
    }
    const st = this.status();
    if (!h.Result) h.Result = st.result;
    for (const [k, v] of Object.entries(h)) lines.push(`[${k} "${v}"]`);
    if (lines.length) lines.push('');

    const replay = new Chess(this._startFen);
    const tokens = [];
    let first = true;
    for (const entry of this._history) {
      if (replay._turn === WHITE) {
        tokens.push(`${replay._moveNumber}.`);
      } else if (first) {
        tokens.push(`${replay._moveNumber}...`);
      }
      tokens.push(replay._toSan(entry.move));
      replay._make(entry.move);
      first = false;
    }
    tokens.push(st.result);
    lines.push(wrapText(tokens.join(' '), 80).join(newline));
    return lines.join(newline);
  }

  /**
   * Loads PGN movetext (headers optional, comments/variations stripped).
   * Throws on an illegal move.
   */
  loadPgn(text) {
    const headers = {};
    const headerRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
    let match;
    let lastIndex = 0;
    while ((match = headerRe.exec(text)) !== null) {
      headers[match[1]] = match[2];
      lastIndex = headerRe.lastIndex;
    }
    let movetext = text.slice(lastIndex);
    movetext = movetext.replace(/\{[^}]*\}/g, ' ');   // comments
    movetext = movetext.replace(/;[^\n]*/g, ' ');      // line comments
    while (/\([^()]*\)/.test(movetext)) movetext = movetext.replace(/\([^()]*\)/g, ' '); // variations
    movetext = movetext.replace(/\$\d+/g, ' ');       // NAGs

    this.load(headers.FEN || START_FEN);
    const tokens = movetext.split(/\s+/).filter(Boolean);
    for (const raw of tokens) {
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(raw)) break;
      const token = raw.replace(/^\d+\.+/, '');
      if (!token) continue;
      if (!this.move(token)) throw new Error(`Недопустимый ход в PGN: "${raw}"`);
    }
    return headers;
  }

  // ------------------------------------------------------------- debugging

  /** Counts leaf nodes of the legal move tree to `depth`. */
  perft(depth) {
    if (depth === 0) return 1;
    const moves = this._generatePseudoLegal();
    const us = this._turn;
    let nodes = 0;
    for (let i = 0; i < moves.length; i++) {
      this._make(moves[i]);
      if (!this._isKingAttacked(us)) {
        nodes += depth === 1 ? 1 : this.perft(depth - 1);
      }
      this._unmake();
    }
    return nodes;
  }

  ascii() {
    const lines = [];
    for (let rank = 7; rank >= 0; rank--) {
      let line = `${rank + 1} |`;
      for (let file = 0; file < 8; file++) {
        const p = this._board[makeSquare(file, rank)];
        line += ' ' + (p === EMPTY ? '.' : pieceToChar(p));
      }
      lines.push(line);
    }
    lines.push('   ----------------');
    lines.push('    a b c d e f g h');
    return lines.join('\n');
  }

  /** Independent copy of the current game (including history). */
  clone() {
    const c = new Chess(this._startFen);
    for (const entry of this._history) c._make(entry.move);
    return c;
  }
}

function pieceObject(piece) {
  if (piece === EMPTY) return null;
  return { type: TYPE_CHAR[typeOf(piece)], color: colorOf(piece) === WHITE ? 'w' : 'b' };
}

function stripSanDecorations(san) {
  return san.replace(/[+#!?]+$/g, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O').replace(/=/g, '=');
}

function wrapText(text, width) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if (current.length + w.length + 1 > width && current) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}
