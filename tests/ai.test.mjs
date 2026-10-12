import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../chess/js/engine/chess.js';
import { findBestMove, evaluate, LEVELS, searchFen } from '../chess/js/ai/ai.js';

describe('evaluation', () => {
  test('start position is balanced', () => {
    assert.equal(evaluate(new Chess()), 0);
  });
  test('extra material is positive for the side that owns it', () => {
    const whiteUp = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    assert.ok(evaluate(whiteUp) > 400);
    const blackToMove = new Chess('4k3/8/8/8/8/8/8/R3K3 b - - 0 1');
    assert.ok(evaluate(blackToMove) < -400, 'score is from the side to move');
  });
});

describe('search', () => {
  test('finds mate in one', () => {
    const chess = new Chess('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    const result = findBestMove(chess, { maxDepth: 3, timeMs: 5000 });
    assert.equal(result.move.from, 'a1');
    assert.equal(result.move.to, 'a8');
    assert.ok(result.score > 90000, `mate score, got ${result.score}`);
  });
  test('finds mate in two (queen sacrifice-free smothered pattern)', () => {
    // White: Kg1, Qh5, Nf7-ready knight on g5; Black: Kh8, Rg8, pawns g7 h7. 1.Qxh7+?? no — 1.Nf7+ Kg8? Only legal reply 1...Kg8 2.Nh6# (double check) is standard.
    const chess = new Chess('6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1');
    const result = findBestMove(chess, { maxDepth: 4, timeMs: 10000 });
    assert.equal(result.move.from, 'g5');
    assert.equal(result.move.to, 'f7');
    assert.ok(result.score > 90000, `mate score, got ${result.score}`);
  });
  test('captures a hanging queen', () => {
    const chess = new Chess('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
    const result = findBestMove(chess, { maxDepth: 2, timeMs: 5000 });
    assert.equal(result.move.to, 'd5');
  });
  test('does not grab a poisoned pawn when the recapture loses the queen (quiescence)', () => {
    // White queen can take the pawn on e5 but it is defended by a pawn on d6.
    const chess = new Chess('4k3/8/3p4/4p3/8/8/8/3QK3 w - - 0 1');
    const result = findBestMove(chess, { maxDepth: 1, timeMs: 5000 });
    assert.ok(!(result.move.to === 'e5'), 'quiescence should see the recapture dxe5');
  });
  test('leaves the position untouched after searching, including on timeout', () => {
    const chess = new Chess();
    chess.move('e4');
    const fen = chess.fen();
    findBestMove(chess, { maxDepth: 3, timeMs: 5000 });
    assert.equal(chess.fen(), fen);
    assert.equal(chess.historyLength(), 1);
    findBestMove(chess, { maxDepth: 12, timeMs: 30 }); // will abort by time
    assert.equal(chess.fen(), fen);
    assert.equal(chess.historyLength(), 1);
  });
  test('returns null when there are no legal moves', () => {
    const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); // stalemate
    assert.equal(findBestMove(chess, { maxDepth: 2 }), null);
  });
  test('always returns a legal move for every level', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    for (const level of Object.values(LEVELS)) {
      const result = searchFen(fen, { ...level, timeMs: Math.min(level.timeMs, 1500) });
      const chess = new Chess(fen);
      assert.ok(chess.move(result.move), `level "${level.label}" produced illegal move ${JSON.stringify(result.move)}`);
    }
  });
  test('promotes to a queen immediately when delaying would lose the pawn', () => {
    // Black rook on h7 attacks b7 along the 7th rank; after b8=Q the queen is safe.
    const chess = new Chess('8/1P5r/8/8/8/8/8/4K2k w - - 0 1');
    const result = findBestMove(chess, { maxDepth: 2, timeMs: 5000 });
    assert.equal(result.move.to, 'b8');
    assert.equal(result.move.promotion, 'q');
  });
});
