/**
 * Application glue: owns the game state, wires the BoardView to the rules
 * engine, drives the AI worker and renders the side panel.
 */
import { Chess, START_FEN } from '../engine/chess.js';
import { AiClient } from '../ai/ai-client.js';
import { LEVELS, MATE_SCORE } from '../ai/ai.js';
import { BoardView, pieceGlyph, describePiece } from './board-view.js';

const STORAGE_KEY = 'chess-game-v1';
const THEME_KEY = 'chess-theme';
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const INITIAL_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const AI_MOVE_DELAY_MS = 350;
const HINT_OPTIONS = { maxDepth: 5, timeMs: 1500, randomness: 0 };

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.game = new Chess();
    this.ai = new AiClient();
    this.settings = { mode: 'hc', level: 3, showLegal: true, orientation: 'w' };
    this.selected = null;
    this.viewPly = null;          // null = live position, otherwise number of plies shown
    this.thinking = false;
    this.hint = null;
    this.lastEval = null;         // centipawns from White's perspective, or null
    this.searchToken = 0;
    this.hintToken = 0;

    this.els = {
      board: $('board'), status: $('status'), announcer: $('announcer'),
      mode: $('mode'), level: $('level'), newGame: $('new-game'), undo: $('undo'), flip: $('flip'), hint: $('hint'),
      showLegal: $('show-legal'), engineInfo: $('engine-info'), moves: $('moves'),
      navFirst: $('nav-first'), navPrev: $('nav-prev'), navNext: $('nav-next'), navLast: $('nav-last'),
      fen: $('fen'), copyFen: $('copy-fen'), loadFen: $('load-fen'), pgn: $('pgn'), copyPgn: $('copy-pgn'), loadPgn: $('load-pgn'),
      positionMessage: $('position-message'),
      playerTop: $('player-top'), playerBottom: $('player-bottom'),
      playerTopName: $('player-top-name'), playerBottomName: $('player-bottom-name'),
      capturedTop: $('captured-top'), capturedBottom: $('captured-bottom'),
      evalBar: $('eval-bar'), evalBarFill: $('eval-bar-fill'),
      promotionModal: $('promotion-modal'), promotionChoices: $('promotion-choices'), promotionCancel: $('promotion-cancel'),
      themeToggle: $('theme-toggle'),
    };

    this.board = new BoardView(this.els.board, {
      onSelect: (sq) => this.onSelect(sq),
      onDrop: (from, to) => this.onDrop(from, to),
      onDragStart: (sq) => this.select(sq),
      onCancel: () => this.deselect(),
      canDrag: (sq) => this.canPick(sq),
    });

    this._initControls();
    this._initTheme();
    this._restore();
    this.render({ animate: false });
    this._maybeRequestAiMove();
  }

  // ------------------------------------------------------------ helpers

  humanControls(color) {
    const { mode } = this.settings;
    return mode === 'hh' || (mode === 'hc' && color === 'w') || (mode === 'ch' && color === 'b');
  }

  isLive() {
    return this.viewPly === null || this.viewPly === this.game.historyLength();
  }

  isAiTurn() {
    return !this.game.isGameOver() && !this.humanControls(this.game.turn());
  }

  canPick(square) {
    if (!this.isLive() || this.thinking || this.game.isGameOver()) return false;
    const piece = this.game.get(square);
    return !!piece && piece.color === this.game.turn() && this.humanControls(piece.color);
  }

  levelOptions() {
    return LEVELS[this.settings.level] || LEVELS[3];
  }

  // -------------------------------------------------------- interaction

  onSelect(square) {
    if (!this.isLive()) {
      this.goToPly(null);
      return;
    }
    if (this.selected && this.selected !== square) {
      const legal = this.game.moves({ square: this.selected, verbose: true });
      if (legal.some((m) => m.to === square)) {
        this.tryMove(this.selected, square);
        return;
      }
    }
    if (this.selected === square) {
      this.deselect();
      return;
    }
    if (this.canPick(square)) this.select(square);
    else this.deselect();
  }

  onDrop(from, to) {
    if (!this.tryMove(from, to)) {
      this.deselect();
    }
  }

  select(square) {
    if (!this.canPick(square)) return;
    this.selected = square;
    this.hint = null;
    this.renderHighlights();
  }

  deselect() {
    if (this.selected === null) return;
    this.selected = null;
    this.renderHighlights();
  }

  /** Attempts a human move; opens the promotion dialog when needed. */
  tryMove(from, to) {
    if (!this.canPick(from)) return false;
    const candidates = this.game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (candidates.length === 0) return false;
    if (candidates[0].promotion) {
      this.openPromotion(from, to, candidates[0].color);
      return true;
    }
    this.applyMove({ from, to });
    return true;
  }

  applyMove(input) {
    const move = this.game.move(input);
    if (!move) return null;
    this.selected = null;
    this.hint = null;
    this.viewPly = null;
    this.render();
    this.announce(move);
    this.save();
    this._maybeRequestAiMove();
    return move;
  }

  announce(move) {
    const status = this.statusText();
    this.els.announcer.textContent = `Ход ${move.color === 'w' ? 'белых' : 'чёрных'}: ${move.san}. ${status}`;
  }

  // ------------------------------------------------------------- promotion

  openPromotion(from, to, color) {
    const choices = this.els.promotionChoices;
    choices.textContent = '';
    for (const type of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promotion-choice';
      btn.setAttribute('aria-label', describePiece({ type, color }));
      const span = document.createElement('span');
      span.className = `piece ${color === 'w' ? 'white' : 'black'}`;
      span.textContent = pieceGlyph(type);
      span.setAttribute('aria-hidden', 'true');
      btn.appendChild(span);
      btn.addEventListener('click', () => {
        this.closePromotion();
        this.applyMove({ from, to, promotion: type });
      });
      choices.appendChild(btn);
    }
    this.els.promotionModal.hidden = false;
    choices.querySelector('button')?.focus();
    this._promotionKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closePromotion(); this.deselect(); this.render(); }
    };
    document.addEventListener('keydown', this._promotionKeyHandler);
  }

  closePromotion() {
    this.els.promotionModal.hidden = true;
    if (this._promotionKeyHandler) document.removeEventListener('keydown', this._promotionKeyHandler);
    this._promotionKeyHandler = null;
    this.board.focusSquareEl(this.board.focusSquare, { focus: false });
  }

  // ------------------------------------------------------------------- AI

  cancelAi() {
    this.searchToken++;
    this.hintToken++;
    this.ai.cancel();
    this.thinking = false;
    this.els.engineInfo.textContent = '';
  }

  _maybeRequestAiMove() {
    if (!this.isAiTurn() || this.thinking) return;
    const token = ++this.searchToken;
    this.thinking = true;
    // Partial re-render only: a full render() would reset the move animation in progress.
    this.renderStatus();
    this.renderHighlights();
    this.board.setViewOnly(true);
    this.els.hint.disabled = true;
    setTimeout(() => {
      if (token !== this.searchToken) return;
      const fen = this.game.fen();
      const { maxDepth, timeMs, randomness } = this.levelOptions();
      this.ai.search(fen, { maxDepth, timeMs, randomness }, (info) => {
        if (token !== this.searchToken) return;
        this.showEngineInfo(info);
      }).then((result) => {
        if (token !== this.searchToken) return;
        this.thinking = false;
        if (result && result.move) {
          this.lastEval = result.score;
          this.showEngineInfo(result);
          this.applyMove(result.move);
        } else {
          this.render();
        }
      }).catch((error) => {
        if (token !== this.searchToken) return;
        this.thinking = false;
        this.els.engineInfo.textContent = `Ошибка движка: ${error.message}`;
        this.render();
      });
    }, AI_MOVE_DELAY_MS);
  }

  requestHint() {
    if (!this.isLive() || this.thinking || this.game.isGameOver()) return;
    const token = ++this.hintToken;
    this.els.hint.disabled = true;
    this.els.engineInfo.textContent = 'Ищу подсказку…';
    this.ai.search(this.game.fen(), HINT_OPTIONS).then((result) => {
      if (token !== this.hintToken) return;
      this.els.hint.disabled = false;
      if (result && result.move) {
        this.hint = [result.move.from, result.move.to];
        this.lastEval = result.score;
        this.showEngineInfo(result, 'Подсказка');
        this.renderHighlights();
        this.renderEvalBar();
      }
    }).catch(() => {
      if (token === this.hintToken) this.els.hint.disabled = false;
    });
  }

  showEngineInfo(info, prefix = 'Компьютер') {
    const parts = [];
    if (info.depth) parts.push(`глубина ${info.depth}`);
    if (info.nodes) parts.push(`${formatNumber(info.nodes)} узлов`);
    if (info.timeMs !== undefined) parts.push(`${(info.timeMs / 1000).toFixed(1).replace('.', ',')} с`);
    if (typeof info.score === 'number') parts.push(`оценка ${formatEval(info.score)}`);
    this.els.engineInfo.textContent = `${prefix}: ${parts.join(' · ')}`;
    if (typeof info.score === 'number') {
      this.lastEval = info.score;
      this.renderEvalBar();
    }
  }

  // ----------------------------------------------------------- game flow

  newGame(fen = START_FEN) {
    this.cancelAi();
    this.game = new Chess(fen);
    this.selected = null;
    this.hint = null;
    this.viewPly = null;
    this.lastEval = null;
    this.setOrientationForMode();
    this.render({ animate: false });
    this.save();
    this.setPositionMessage('');
    this._maybeRequestAiMove();
  }

  setOrientationForMode() {
    if (this.settings.mode === 'ch') this.settings.orientation = 'b';
    else if (this.settings.mode === 'hc') this.settings.orientation = 'w';
  }

  undo() {
    if (this.game.historyLength() === 0) return;
    this.cancelAi();
    this.game.undo();
    // Against the computer, take back its reply too so the human is to move again.
    if (this.settings.mode !== 'hh' && this.settings.mode !== 'cc' &&
        !this.humanControls(this.game.turn()) && this.game.historyLength() > 0) {
      this.game.undo();
    }
    this.selected = null;
    this.hint = null;
    this.viewPly = null;
    this.render();
    this.save();
    this._maybeRequestAiMove();
  }

  flip() {
    this.settings.orientation = this.settings.orientation === 'w' ? 'b' : 'w';
    this.render({ animate: false });
    this.save();
  }

  goToPly(ply) {
    const total = this.game.historyLength();
    if (ply === null || ply >= total) this.viewPly = null;
    else this.viewPly = Math.max(0, ply);
    this.selected = null;
    this.render();
  }

  currentPly() {
    return this.isLive() ? this.game.historyLength() : this.viewPly;
  }

  loadFen(fen) {
    try {
      this.newGame(fen.trim());
      this.setPositionMessage('Позиция загружена.');
    } catch (error) {
      this.setPositionMessage(error.message, true);
    }
  }

  loadPgn(text) {
    try {
      const game = new Chess();
      game.loadPgn(text);
      this.cancelAi();
      this.game = game;
      this.selected = null;
      this.hint = null;
      this.viewPly = null;
      this.lastEval = null;
      this.setOrientationForMode();
      this.render({ animate: false });
      this.save();
      this.setPositionMessage(`Партия загружена: ${game.historyLength()} полуходов.`);
      this._maybeRequestAiMove();
    } catch (error) {
      this.setPositionMessage(error.message, true);
    }
  }

  setPositionMessage(text, isError = false) {
    this.els.positionMessage.textContent = text;
    this.els.positionMessage.classList.toggle('error', isError);
  }

  // ----------------------------------------------------------- rendering

  displayGame() {
    if (this.isLive()) return this.game;
    const history = this.game.history({ verbose: true });
    const fen = this.viewPly === 0 ? this.game.startFen() : history[this.viewPly - 1].after;
    return new Chess(fen);
  }

  render({ animate = true } = {}) {
    const shown = this.displayGame();
    this.board.setOrientation(this.settings.orientation);
    const pieces = {};
    for (const row of shown.board()) {
      for (const cell of row) if (cell) pieces[cell.square] = { type: cell.type, color: cell.color };
    }
    this.board.setPosition(pieces, { animate });
    this.board.setViewOnly(!this.isLive() || this.thinking || this.game.isGameOver() || !this.humanControls(this.game.turn()));
    this.renderHighlights(shown);
    this.renderStatus(shown);
    this.renderMoves();
    this.renderPlayers(shown);
    this.renderPositionFields(shown);
    this.renderEvalBar();
    this.els.undo.disabled = this.game.historyLength() === 0;
    this.els.hint.disabled = !this.isLive() || this.thinking || this.game.isGameOver();
    const ply = this.currentPly();
    this.els.navFirst.disabled = this.els.navPrev.disabled = ply === 0;
    this.els.navNext.disabled = this.els.navLast.disabled = this.isLive();
  }

  renderHighlights(shown = this.displayGame()) {
    const history = this.game.history({ verbose: true });
    const ply = this.currentPly();
    const last = ply > 0 ? history[ply - 1] : null;
    let check = null;
    if (shown.inCheck()) {
      const king = shown.board().flat().find((c) => c && c.type === 'k' && c.color === shown.turn());
      check = king ? king.square : null;
    }
    const live = this.isLive();
    const dests = live && this.selected && this.settings.showLegal
      ? this.game.moves({ square: this.selected, verbose: true }).map((m) => ({ square: m.to, capture: !!m.captured }))
      : [];
    const movable = live && !this.thinking && !this.game.isGameOver() && this.humanControls(this.game.turn())
      ? shown.board().flat().filter((c) => c && c.color === shown.turn()).map((c) => c.square)
      : [];
    this.board.setHighlights({
      selected: live ? this.selected : null,
      dests,
      lastMove: last ? [last.from, last.to] : null,
      check,
      hint: live ? this.hint : null,
      movable,
    });
  }

  statusText(shown = this.displayGame()) {
    const st = shown.status();
    const side = shown.turn() === 'w' ? 'белых' : 'чёрных';
    if (st.over) {
      switch (st.reason) {
        case 'checkmate': return `Мат! Победа ${st.winner === 'w' ? 'белых' : 'чёрных'}.`;
        case 'stalemate': return 'Пат — ничья.';
        case 'insufficient': return 'Ничья: недостаточно материала для мата.';
        case 'repetition': return 'Ничья: троекратное повторение позиции.';
        case 'fifty': return 'Ничья: правило 50 ходов.';
        default: return 'Партия окончена.';
      }
    }
    let text = `Ход ${side}`;
    if (st.check) text += ' — шах!';
    if (this.isLive() && this.thinking) text = `Компьютер думает за ${side}…`;
    return text;
  }

  renderStatus(shown = this.displayGame()) {
    const st = shown.status();
    this.els.status.textContent = this.statusText(shown) + (this.isLive() ? '' : ` (просмотр, ход ${Math.ceil(this.viewPly / 2)})`);
    this.els.status.classList.toggle('check', !st.over && st.check);
    this.els.status.classList.toggle('game-over', st.over);
  }

  renderMoves() {
    const list = this.els.moves;
    const history = this.game.history();
    const current = this.currentPly();
    list.textContent = '';
    if (history.length === 0) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="empty">Ходов пока нет.</span>';
      list.appendChild(li);
      return;
    }
    const fenParts = this.game.startFen().split(' ');
    let number = Number(fenParts[5]) || 1;
    const startsWithBlack = fenParts[1] === 'b';

    const plyButton = (san, ply) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ply' + (ply === current ? ' current' : '');
      btn.textContent = san;
      btn.addEventListener('click', () => this.goToPly(ply));
      return btn;
    };
    const addRow = (white, black) => {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'move-number';
      num.textContent = `${number}.`;
      li.appendChild(num);
      if (white) {
        li.appendChild(plyButton(white.san, white.ply));
      } else {
        const gap = document.createElement('span');
        gap.className = 'ply';
        gap.textContent = '…';
        li.appendChild(gap);
      }
      if (black) li.appendChild(plyButton(black.san, black.ply));
      list.appendChild(li);
      number++;
    };

    const plies = history.map((san, idx) => ({ san, ply: idx + 1 }));
    let i = 0;
    if (startsWithBlack) {
      addRow(null, plies[0]);
      i = 1;
    }
    for (; i < plies.length; i += 2) addRow(plies[i], plies[i + 1]);
    const st = this.game.status();
    if (st.over) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="result">${st.result}</span>`;
      list.appendChild(li);
    }
    list.querySelector('.ply.current')?.scrollIntoView({ block: 'nearest' });
  }

  renderPlayers(shown) {
    const { mode, level, orientation } = this.settings;
    const name = (color) => {
      const human = this.humanControls(color);
      const base = color === 'w' ? 'Белые' : 'Чёрные';
      if (mode === 'hh') return base;
      return human ? `${base} — вы` : `${base} — компьютер (${LEVELS[level].label.toLowerCase()})`;
    };
    const bottomColor = orientation;
    const topColor = orientation === 'w' ? 'b' : 'w';
    this.els.playerBottomName.textContent = name(bottomColor);
    this.els.playerTopName.textContent = name(topColor);
    const turn = shown.turn();
    this.els.playerBottom.classList.toggle('active', turn === bottomColor && !shown.isGameOver());
    this.els.playerTop.classList.toggle('active', turn === topColor && !shown.isGameOver());

    const captured = capturedPieces(shown);
    this.els.capturedBottom.innerHTML = capturedHtml(captured, bottomColor);
    this.els.capturedTop.innerHTML = capturedHtml(captured, topColor);
  }

  renderPositionFields(shown) {
    this.els.fen.value = shown.fen();
    if (document.activeElement !== this.els.pgn) {
      this.els.pgn.value = this.game.pgn({ headers: { Event: 'Партия в браузере', Date: todayPgnDate() } });
    }
  }

  renderEvalBar() {
    const bar = this.els.evalBar;
    bar.classList.toggle('flipped', this.settings.orientation === 'b');
    let whiteShare = 0.5;
    if (typeof this.lastEval === 'number') {
      const cp = this.lastEval;
      if (Math.abs(cp) > MATE_SCORE - 1000) whiteShare = cp > 0 ? 1 : 0;
      else whiteShare = 1 / (1 + Math.pow(10, -cp / 400));
    }
    const pct = Math.round(whiteShare * 100);
    // The white part grows from the white side of the board.
    this.els.evalBarFill.style.height = `${pct}%`;
    this.els.evalBarFill.style.top = this.settings.orientation === 'b' ? '0' : `${100 - pct}%`;
    bar.title = typeof this.lastEval === 'number' ? `Оценка: ${formatEval(this.lastEval)}` : 'Оценка: нет данных';
  }

  // --------------------------------------------------------- persistence

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        startFen: this.game.startFen(),
        moves: this.game.history(),
        settings: this.settings,
      }));
    } catch { /* storage may be unavailable */ }
  }

  _restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.settings) this.settings = { ...this.settings, ...data.settings };
      const game = new Chess(data.startFen || START_FEN);
      for (const san of data.moves || []) {
        if (!game.move(san)) throw new Error('bad history');
      }
      this.game = game;
    } catch {
      this.game = new Chess();
    }
    this.els.mode.value = this.settings.mode;
    this.els.level.value = String(this.settings.level);
    this.els.showLegal.checked = this.settings.showLegal;
  }

  // ------------------------------------------------------------ controls

  _initControls() {
    const e = this.els;
    for (const [key, level] of Object.entries(LEVELS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${key} — ${level.label}`;
      e.level.appendChild(opt);
    }
    e.level.value = String(this.settings.level);

    e.mode.addEventListener('change', () => {
      this.cancelAi();
      this.settings.mode = e.mode.value;
      this.selected = null;
      this.setOrientationForMode();
      this.render({ animate: false });
      this.save();
      this._maybeRequestAiMove();
    });
    e.level.addEventListener('change', () => {
      this.settings.level = Number(e.level.value);
      this.render({ animate: false });
      this.save();
    });
    e.showLegal.addEventListener('change', () => {
      this.settings.showLegal = e.showLegal.checked;
      this.renderHighlights();
      this.save();
    });
    e.newGame.addEventListener('click', () => this.newGame());
    e.undo.addEventListener('click', () => this.undo());
    e.flip.addEventListener('click', () => this.flip());
    e.hint.addEventListener('click', () => this.requestHint());

    e.navFirst.addEventListener('click', () => this.goToPly(0));
    e.navPrev.addEventListener('click', () => this.goToPly(this.currentPly() - 1));
    e.navNext.addEventListener('click', () => this.goToPly(this.currentPly() + 1));
    e.navLast.addEventListener('click', () => this.goToPly(null));

    e.copyFen.addEventListener('click', () => copyText(e.fen.value).then(
      () => this.setPositionMessage('FEN скопирован.'),
      () => this.setPositionMessage('Не удалось скопировать.', true),
    ));
    e.loadFen.addEventListener('click', () => this.loadFen(e.fen.value));
    e.fen.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); this.loadFen(e.fen.value); } });
    e.copyPgn.addEventListener('click', () => copyText(e.pgn.value).then(
      () => this.setPositionMessage('PGN скопирован.'),
      () => this.setPositionMessage('Не удалось скопировать.', true),
    ));
    e.loadPgn.addEventListener('click', () => this.loadPgn(e.pgn.value));
    e.promotionCancel.addEventListener('click', () => { this.closePromotion(); this.deselect(); this.render(); });
    e.promotionModal.addEventListener('click', (ev) => {
      if (ev.target === e.promotionModal) { this.closePromotion(); this.deselect(); this.render(); }
    });

    document.addEventListener('keydown', (ev) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!e.promotionModal.hidden) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); this.undo(); return; }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      switch (ev.key) {
        case 'ArrowLeft': ev.preventDefault(); this.goToPly(this.currentPly() - 1); break;
        case 'ArrowRight': ev.preventDefault(); this.goToPly(this.currentPly() + 1); break;
        case 'Home': ev.preventDefault(); this.goToPly(0); break;
        case 'End': ev.preventDefault(); this.goToPly(null); break;
        case 'f': case 'F': case 'а': case 'А': this.flip(); break;
        case 'h': case 'H': case 'р': case 'Р': this.requestHint(); break;
        default: break;
      }
    });
  }

  _initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.dataset.theme = saved;
    this.els.themeToggle.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme
        || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    });
  }
}

// ------------------------------------------------------------------ utils

function capturedPieces(game) {
  const counts = { w: { ...INITIAL_COUNTS }, b: { ...INITIAL_COUNTS } };
  for (const cell of game.board().flat()) {
    if (cell && cell.type !== 'k') counts[cell.color][cell.type]--;
  }
  // Promotions can make counts negative; clamp them.
  const captured = { w: [], b: [] }; // captured.w = white pieces that were captured (shown next to Black)
  for (const color of ['w', 'b']) {
    for (const type of ['q', 'r', 'b', 'n', 'p']) {
      for (let i = 0; i < Math.max(0, counts[color][type]); i++) captured[color].push(type);
    }
  }
  const material = (color) => captured[color].reduce((sum, t) => sum + PIECE_VALUES[t], 0);
  return { captured, materialDiff: { w: material('b') - material('w'), b: material('w') - material('b') } };
}

/** Pieces captured *by* `color` (i.e. the opponent's lost pieces) plus the material balance. */
function capturedHtml({ captured, materialDiff }, color) {
  const opponent = color === 'w' ? 'b' : 'w';
  const glyphs = captured[opponent]
    .map((t) => `<span class="piece-mini ${opponent === 'w' ? 'white' : 'black'}" aria-hidden="true">${pieceGlyph(t)}</span>`)
    .join('');
  const diff = materialDiff[color];
  const diffHtml = diff > 0 ? `<span class="material">+${diff}</span>` : '';
  return glyphs + diffHtml;
}

function formatEval(cp) {
  if (Math.abs(cp) > MATE_SCORE - 1000) {
    const plies = MATE_SCORE - Math.abs(cp);
    return `${cp > 0 ? '' : '-'}M${Math.ceil(plies / 2)}`;
  }
  const pawns = cp / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2).replace('.', ',');
}

function formatNumber(n) {
  return new Intl.NumberFormat('ru-RU').format(n);
}

function todayPgnDate() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    ok ? resolve() : reject(new Error('copy failed'));
  });
}

window.chessApp = new App();
