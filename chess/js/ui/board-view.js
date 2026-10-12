/**
 * BoardView: renders a position into an 8x8 grid of <button> squares and
 * turns pointer / keyboard input into high-level callbacks. It contains no
 * chess rules; the app decides what is legal.
 *
 * Callbacks (all optional):
 *   onSelect(square)           user clicked/pressed a square
 *   onDrop(from, to)           user dragged a piece from -> to
 *   onDragStart(square)        a drag began (app usually selects the piece)
 *   onCancel()                 Escape pressed / drag cancelled
 *   canDrag(square) -> bool    whether a drag may start from the square
 */

const FILES = 'abcdefgh';
const GLYPHS = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F' };
const PIECE_NAMES_RU = { k: 'король', q: 'ферзь', r: 'ладья', b: 'слон', n: 'конь', p: 'пешка' };
const COLOR_NAMES_RU = { w: 'белый', b: 'чёрный' };
const COLOR_NAMES_RU_F = { w: 'белая', b: 'чёрная' };

export function pieceGlyph(type) {
  // U+FE0E forces text presentation (avoids emoji rendering of the pawn on some platforms).
  return GLYPHS[type] + '\uFE0E';
}

export function describePiece(piece) {
  if (!piece) return 'пусто';
  const feminine = piece.type === 'p' || piece.type === 'r';
  const color = feminine ? COLOR_NAMES_RU_F[piece.color] : COLOR_NAMES_RU[piece.color];
  return `${color} ${PIECE_NAMES_RU[piece.type]}`;
}

export class BoardView {
  constructor(boardEl, callbacks = {}) {
    this.el = boardEl;
    this.cb = callbacks;
    this.orientation = 'w';
    this.pieces = {};        // square -> {type, color}
    this.squares = new Map(); // square -> element
    this.highlights = { selected: null, dests: [], lastMove: null, check: null, hint: null, movable: [] };
    this.focusSquare = 'e2';
    this._drag = null;
    this._ghost = null;
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this._buildSquares();
    this._bindEvents();
    this._observeSize();
  }

  // ---------------------------------------------------------------- layout

  _squareOrder() {
    const order = [];
    const ranks = this.orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = this.orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    for (const rank of ranks) {
      const row = [];
      for (const f of files) row.push(FILES[f] + rank);
      order.push(row);
    }
    return order;
  }

  _buildSquares() {
    this.el.textContent = '';
    this.squares.clear();
    const rows = this._squareOrder();
    rows.forEach((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'rank';
      rowEl.setAttribute('role', 'row');
      rowEl.setAttribute('aria-rowindex', String(r + 1));
      row.forEach((square, c) => {
        const file = FILES.indexOf(square[0]);
        const rank = Number(square[1]);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'square ' + ((file + rank) % 2 === 1 ? 'light' : 'dark');
        btn.dataset.square = square;
        btn.setAttribute('role', 'gridcell');
        btn.setAttribute('aria-colindex', String(c + 1));
        btn.tabIndex = -1;
        if (c === 0) {
          const label = document.createElement('span');
          label.className = 'coord rank-label';
          label.textContent = String(rank);
          label.setAttribute('aria-hidden', 'true');
          btn.appendChild(label);
        }
        if (r === 7) {
          const label = document.createElement('span');
          label.className = 'coord file-label';
          label.textContent = square[0];
          label.setAttribute('aria-hidden', 'true');
          btn.appendChild(label);
        }
        rowEl.appendChild(btn);
        this.squares.set(square, btn);
      });
      this.el.appendChild(rowEl);
    });
    this._renderPieces(null);
    this._applyHighlights();
    this._updateTabStops();
  }

  _observeSize() {
    const update = () => {
      const size = this.el.getBoundingClientRect().width / 8;
      if (size > 0) this.el.style.setProperty('--square-px', `${size}px`);
    };
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(update).observe(this.el);
    } else {
      window.addEventListener('resize', update);
    }
    update();
  }

  // ------------------------------------------------------------- rendering

  setOrientation(color) {
    if (this.orientation === color) return;
    this.orientation = color;
    this._buildSquares();
  }

  /**
   * @param {Object<string,{type,color}>} pieces square -> piece
   * @param {{animate?: boolean}} options
   */
  setPosition(pieces, { animate = true } = {}) {
    const previous = this.pieces;
    this.pieces = { ...pieces };
    this._renderPieces(animate && !this._reducedMotion ? previous : null);
  }

  _renderPieces(previous) {
    const moved = previous ? this._pairMovedPieces(previous, this.pieces) : null;
    for (const [square, el] of this.squares) {
      const piece = this.pieces[square] || null;
      let pieceEl = el.querySelector('.piece');
      if (!piece) {
        if (pieceEl) pieceEl.remove();
      } else {
        const className = `piece ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}`;
        if (!pieceEl) {
          pieceEl = document.createElement('span');
          pieceEl.setAttribute('aria-hidden', 'true');
          el.appendChild(pieceEl);
        }
        if (pieceEl.className !== className) pieceEl.className = className;
        const glyph = pieceGlyph(piece.type);
        if (pieceEl.textContent !== glyph) pieceEl.textContent = glyph;
        pieceEl.style.transform = '';
      }
      el.setAttribute('aria-label', `${square}, ${describePiece(piece)}`);
    }
    if (moved) this._animate(moved);
  }

  /** Pairs pieces that disappeared from one square and appeared on another (same type and color). */
  _pairMovedPieces(before, after) {
    const vanished = [];
    const appeared = [];
    for (const sq of Object.keys(before)) {
      const a = after[sq];
      if (!a || a.type !== before[sq].type || a.color !== before[sq].color) vanished.push({ square: sq, piece: before[sq] });
    }
    for (const sq of Object.keys(after)) {
      const b = before[sq];
      if (!b || b.type !== after[sq].type || b.color !== after[sq].color) appeared.push({ square: sq, piece: after[sq] });
    }
    const pairs = [];
    for (const dest of appeared) {
      const i = vanished.findIndex((v) => v.piece.type === dest.piece.type && v.piece.color === dest.piece.color);
      if (i !== -1) {
        pairs.push({ from: vanished[i].square, to: dest.square });
        vanished.splice(i, 1);
      }
    }
    return pairs;
  }

  /** FLIP animation: start the piece at its old position and transition to the new one. */
  _animate(pairs) {
    const boardRect = this.el.getBoundingClientRect();
    if (boardRect.width === 0) return;
    for (const { from, to } of pairs) {
      const fromEl = this.squares.get(from);
      const toEl = this.squares.get(to);
      const pieceEl = toEl?.querySelector('.piece');
      if (!fromEl || !toEl || !pieceEl) continue;
      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      pieceEl.classList.remove('anim');
      pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;
      // Force style flush so the transition starts from the translated position.
      void pieceEl.offsetWidth;
      pieceEl.classList.add('anim');
      pieceEl.style.transform = 'translate(0, 0)';
      pieceEl.addEventListener('transitionend', () => pieceEl.classList.remove('anim'), { once: true });
    }
  }

  /**
   * @param {{selected?: string|null, dests?: {square: string, capture: boolean}[], lastMove?: [string,string]|null,
   *          check?: string|null, hint?: [string,string]|null, movable?: string[]}} h
   */
  setHighlights(h) {
    this.highlights = { ...this.highlights, ...h };
    this._applyHighlights();
  }

  _applyHighlights() {
    const { selected, dests, lastMove, check, hint, movable } = this.highlights;
    const destMap = new Map((dests || []).map((d) => [d.square, d.capture]));
    const movableSet = new Set(movable || []);
    for (const [square, el] of this.squares) {
      el.classList.toggle('selected', selected === square);
      el.classList.toggle('dest', destMap.has(square));
      el.classList.toggle('capture', destMap.get(square) === true);
      el.classList.toggle('last-move', !!lastMove && (lastMove[0] === square || lastMove[1] === square));
      el.classList.toggle('check', check === square);
      el.classList.toggle('hint', !!hint && (hint[0] === square || hint[1] === square));
      el.classList.toggle('can-move', movableSet.has(square));
    }
  }

  setViewOnly(viewOnly) {
    this.el.classList.toggle('view-only', viewOnly);
  }

  // ------------------------------------------------------------- keyboard

  _updateTabStops() {
    for (const [square, el] of this.squares) el.tabIndex = square === this.focusSquare ? 0 : -1;
  }

  focusSquareEl(square, { focus = true } = {}) {
    if (!this.squares.has(square)) return;
    this.focusSquare = square;
    this._updateTabStops();
    if (focus) this.squares.get(square).focus();
  }

  _moveFocus(dFile, dRank) {
    const file = FILES.indexOf(this.focusSquare[0]);
    const rank = Number(this.focusSquare[1]);
    const sign = this.orientation === 'w' ? 1 : -1;
    const nf = Math.min(7, Math.max(0, file + dFile * sign));
    const nr = Math.min(8, Math.max(1, rank + dRank * sign));
    this.focusSquareEl(FILES[nf] + nr);
  }

  // --------------------------------------------------------------- events

  _bindEvents() {
    this.el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.el.addEventListener('pointercancel', () => this._cancelDrag(true));
    this.el.addEventListener('lostpointercapture', () => { if (this._drag && this._drag.started) this._cancelDrag(true); });
    this.el.addEventListener('contextmenu', (e) => { if (this._drag) e.preventDefault(); });
    this.el.addEventListener('keydown', (e) => this._onKeyDown(e));
    // When the board container itself gets focus (Tab), hand focus to the current square.
    this.el.addEventListener('focus', (e) => {
      if (e.target === this.el) this.focusSquareEl(this.focusSquare);
    });
    this.el.addEventListener('focusin', (e) => {
      const square = e.target?.dataset?.square;
      if (square) { this.focusSquare = square; this._updateTabStops(); }
    });
  }

  _squareFromEvent(e) {
    const target = e.target.closest?.('.square');
    return target ? target.dataset.square : null;
  }

  _squareAtPoint(x, y) {
    const rect = this.el.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    const file = this.orientation === 'w' ? col : 7 - col;
    const rank = this.orientation === 'w' ? 8 - row : row + 1;
    return FILES[file] + rank;
  }

  _onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const square = this._squareFromEvent(e);
    if (!square) return;
    e.preventDefault();
    this.focusSquareEl(square, { focus: false });
    const canDrag = this.pieces[square] && (!this.cb.canDrag || this.cb.canDrag(square));
    this._drag = {
      from: square,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      started: false,
      canDrag,
      over: null,
    };
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (!d.canDrag) return;
      const threshold = d.pointerType === 'touch' ? 10 : 4;
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < threshold) return;
      d.started = true;
      this._startGhost(d.from);
      this.cb.onDragStart?.(d.from);
    }
    this._moveGhost(e.clientX, e.clientY);
    const over = this._squareAtPoint(e.clientX, e.clientY);
    if (over !== d.over) {
      if (d.over) this.squares.get(d.over)?.classList.remove('drag-over');
      if (over) this.squares.get(over)?.classList.add('drag-over');
      d.over = over;
    }
  }

  _onPointerUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.started) {
      const to = this._squareAtPoint(e.clientX, e.clientY);
      this._cancelDrag(false);
      if (to && to !== d.from) this.cb.onDrop?.(d.from, to);
      else this.cb.onCancel?.();
    } else {
      this._drag = null;
      this.cb.onSelect?.(d.from);
    }
  }

  _startGhost(square) {
    const pieceEl = this.squares.get(square)?.querySelector('.piece');
    if (!pieceEl) return;
    pieceEl.classList.add('dragging');
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    const clone = pieceEl.cloneNode(true);
    clone.classList.remove('dragging');
    ghost.appendChild(clone);
    this.el.appendChild(ghost);
    this._ghost = ghost;
  }

  _moveGhost(x, y) {
    if (!this._ghost) return;
    const rect = this.el.getBoundingClientRect();
    this._ghost.style.transform = `translate(${x - rect.left}px, ${y - rect.top}px) translate(-50%, -50%)`;
  }

  _cancelDrag(notify) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.over) this.squares.get(d.over)?.classList.remove('drag-over');
    this.squares.get(d.from)?.querySelector('.piece')?.classList.remove('dragging');
    if (this._ghost) { this._ghost.remove(); this._ghost = null; }
    if (notify && d.started) this.cb.onCancel?.();
  }

  _onKeyDown(e) {
    const square = e.target?.dataset?.square || this.focusSquare;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); this._moveFocus(0, 1); break;
      case 'ArrowDown': e.preventDefault(); this._moveFocus(0, -1); break;
      case 'ArrowLeft': e.preventDefault(); this._moveFocus(-1, 0); break;
      case 'ArrowRight': e.preventDefault(); this._moveFocus(1, 0); break;
      case 'Home': e.preventDefault(); this.focusSquareEl((this.orientation === 'w' ? 'a' : 'h') + square[1]); break;
      case 'End': e.preventDefault(); this.focusSquareEl((this.orientation === 'w' ? 'h' : 'a') + square[1]); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.cb.onSelect?.(square);
        break;
      case 'Escape':
        e.preventDefault();
        this.cb.onCancel?.();
        break;
      default:
        return;
    }
    e.stopPropagation();
  }
}
