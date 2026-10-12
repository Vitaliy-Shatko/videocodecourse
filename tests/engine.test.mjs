import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Chess, START_FEN } from '../chess/js/engine/chess.js';

// Reference values: https://www.chessprogramming.org/Perft_Results
describe('perft (move generator correctness)', () => {
  const cases = [
    ['start position', START_FEN, [20, 400, 8902, 197281]],
    ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['position 3 (en passant / pins)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['position 4 (promotions)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
    ['position 4 mirrored', 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', [6, 264, 9467]],
    ['position 5 (talkchess)', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
    ['position 6 (edwards)', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ];
  for (const [name, fen, expected] of cases) {
    test(name, () => {
      const chess = new Chess(fen);
      expected.forEach((nodes, i) => {
        assert.equal(chess.perft(i + 1), nodes, `perft(${i + 1})`);
      });
      assert.equal(chess.fen(), fen, 'position restored after perft');
    });
  }
});

describe('FEN', () => {
  test('round-trips the start position', () => {
    assert.equal(new Chess().fen(), START_FEN);
  });
  test('round-trips arbitrary positions', () => {
    const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b Kq e3 5 12';
    assert.equal(new Chess(fen).fen(), fen);
  });
  test('rejects garbage', () => {
    assert.throws(() => new Chess('not a fen'));
    assert.throws(() => new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'));
    assert.throws(() => new Chess('8/8/8/8/8/8/8/8 w - - 0 1'), /корол/);
  });
  test('rejects a position where the side not to move is in check', () => {
    assert.throws(() => new Chess('4k2R/8/8/8/8/8/8/4K3 w - - 0 1'));
  });
});

describe('basic moves', () => {
  test('plays a move via object and via SAN', () => {
    const c = new Chess();
    const m = c.move({ from: 'e2', to: 'e4' });
    assert.equal(m.san, 'e4');
    assert.equal(m.flags & 2, 2, 'double pawn flag');
    assert.equal(c.fen(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    assert.equal(c.move('e5').san, 'e5');
    assert.equal(c.move('Nf3').san, 'Nf3');
    assert.equal(c.turn(), 'b');
  });
  test('rejects illegal moves', () => {
    const c = new Chess();
    assert.equal(c.move({ from: 'e2', to: 'e5' }), null);
    assert.equal(c.move({ from: 'e7', to: 'e5' }), null, 'cannot move opponent piece');
    assert.equal(c.move('Qh5'), null);
    assert.equal(c.fen(), START_FEN);
  });
  test('accepts UCI-style strings', () => {
    const c = new Chess();
    assert.equal(c.move('g1f3').san, 'Nf3');
  });
  test('undo restores the previous position', () => {
    const c = new Chess();
    c.move('e4'); c.move('e5'); c.move('Nf3');
    const undone = c.undo();
    assert.equal(undone.san, 'Nf3');
    assert.equal(c.fen(), 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
    c.undo(); c.undo();
    assert.equal(c.fen(), START_FEN);
    assert.equal(c.undo(), null);
  });
  test('moves({square}) lists only moves of that piece', () => {
    const c = new Chess();
    assert.deepEqual(c.moves({ square: 'g1' }).sort(), ['Nf3', 'Nh3']);
    assert.deepEqual(c.moves({ square: 'e2' }).sort(), ['e3', 'e4']);
    assert.deepEqual(c.moves({ square: 'e1' }), []);
    assert.deepEqual(c.moves({ square: 'z9' }), []);
  });
});

describe('special rules', () => {
  test('castling king side and queen side', () => {
    const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    assert.ok(c.moves().includes('O-O'));
    assert.ok(c.moves().includes('O-O-O'));
    const m = c.move('O-O');
    assert.equal(m.flags & 16, 16);
    assert.equal(c.get('g1').type, 'k');
    assert.equal(c.get('f1').type, 'r');
    assert.equal(c.get('e1'), null);
    assert.equal(c.get('h1'), null);
    c.move('O-O-O');
    assert.equal(c.get('c8').type, 'k');
    assert.equal(c.get('d8').type, 'r');
    assert.equal(c.fen().split(' ')[2], '-', 'all castling rights consumed');
    c.undo(); c.undo();
    assert.equal(c.fen(), 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  });
  test('cannot castle out of, through, or into check', () => {
    // Black rook on the e-file gives check to e1.
    assert.ok(!new Chess('1k2r3/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O'));
    assert.ok(!new Chess('1k2r3/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O-O'));
    // Rook attacks f1: king passes through f1.
    assert.ok(!new Chess('1k3r2/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O'));
    assert.ok(new Chess('1k3r2/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O-O'));
    // Rook attacks g1: king lands on g1.
    assert.ok(!new Chess('1k4r1/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O'));
    // Queen side: b1 attacked is fine (only the rook passes over it), c1/d1 are not.
    assert.ok(new Chess('1rk5/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O-O'));
    assert.ok(!new Chess('1k1r4/8/8/8/8/8/8/R3K2R w KQ - 0 1').moves().includes('O-O-O'));
    // Squares between king and rook must be empty (b1 matters for O-O-O even though the king never crosses it).
    assert.ok(!new Chess('1k6/8/8/8/8/8/8/RN2K2R w KQ - 0 1').moves().includes('O-O-O'));
  });
  test('castling rights are lost when king or rook moves, or rook is captured', () => {
    const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    c.move('Rh2'); // white loses K
    assert.equal(c.fen().split(' ')[2], 'Qkq');
    c.move('Kf8'); // black loses both
    assert.equal(c.fen().split(' ')[2], 'Q');
    const d = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    d.move('Rxa8+');
    assert.equal(d.fen().split(' ')[2], 'Kk');
  });
  test('en passant capture', () => {
    const c = new Chess();
    c.move('e4'); c.move('a6'); c.move('e5'); c.move('d5');
    assert.equal(c.fen().split(' ')[3], 'd6');
    const m = c.move('exd6');
    assert.equal(m.flags & 4, 4, 'en passant flag');
    assert.equal(m.captured, 'p');
    assert.equal(c.get('d5'), null, 'captured pawn removed');
    assert.equal(c.get('d6').type, 'p');
    c.undo();
    assert.equal(c.get('d5').type, 'p');
    assert.equal(c.get('e5').type, 'p');
  });
  test('en passant is only available immediately', () => {
    const c = new Chess();
    c.move('e4'); c.move('a6'); c.move('e5'); c.move('d5'); c.move('h3'); c.move('h6');
    assert.ok(!c.moves().includes('exd6'));
  });
  test('en passant that would expose the king is illegal', () => {
    // White king a5, white pawn b5, black pawn c5 just moved c7-c5, black rook h5: bxc6 e.p. exposes king along the 5th rank.
    const c = new Chess('8/8/8/KPp4r/8/8/8/4k3 w - c6 0 2');
    assert.ok(!c.moves().includes('bxc6'));
  });
  test('promotion to all pieces, queen by default', () => {
    const c = new Chess('8/P6k/8/8/8/8/8/4K3 w - - 0 1');
    assert.deepEqual(c.moves({ square: 'a7' }).sort(), ['a8=B', 'a8=N', 'a8=Q', 'a8=R']);
    const m = c.move({ from: 'a7', to: 'a8' });
    assert.equal(m.promotion, 'q');
    assert.equal(c.get('a8').type, 'q');
    c.undo();
    assert.equal(c.move({ from: 'a7', to: 'a8', promotion: 'n' }).san, 'a8=N');
    assert.equal(c.get('a8').type, 'n');
    c.undo();
    assert.equal(c.get('a7').type, 'p');
    assert.equal(c.get('a8'), null);
  });
  test('promotion with capture and check', () => {
    const c = new Chess('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const m = c.move('axb8=Q+');
    assert.equal(m.captured, 'n');
    assert.ok(c.inCheck());
  });
  test('pinned pieces cannot move off the pin line', () => {
    const c = new Chess('4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1');
    assert.deepEqual(c.moves({ square: 'e2' }), []);
  });
  test('must respond to check', () => {
    const c = new Chess('4k3/8/8/8/8/8/8/r3K3 w - - 0 1');
    assert.ok(c.inCheck());
    assert.deepEqual(c.moves().sort(), ['Kd2', 'Ke2', 'Kf2']);
  });
});

describe('SAN', () => {
  test('disambiguation by file, rank and square', () => {
    const rooks = new Chess('4k3/8/8/8/8/8/4K3/R6R w - - 0 1').moves();
    assert.ok(rooks.includes('Rad1'));
    assert.ok(rooks.includes('Rhd1'));
    assert.ok(!rooks.includes('Rd1'));
    const stacked = new Chess('4k3/8/R7/8/8/8/R7/4K3 w - - 0 1').moves();
    assert.ok(stacked.includes('R6a4'));
    assert.ok(stacked.includes('R2a4'));
    // Three queens can reach e1: h4 (shares file with h1 and rank with e4) needs the full square.
    const queens = new Chess('1k6/8/8/8/4Q2Q/8/8/K6Q w - - 0 1').moves();
    assert.ok(queens.includes('Qh4e1'));
    assert.ok(queens.includes('Q1e1'));
    assert.ok(queens.includes('Qee1'));
  });
  test('check and mate suffixes', () => {
    const c = new Chess();
    c.move('f3'); c.move('e5'); c.move('g4');
    const m = c.move('Qh4#');
    assert.equal(m.san, 'Qh4#');
    assert.ok(c.isCheckmate());
    const d = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    assert.equal(d.move('Ra8+').san, 'Ra8+');
  });
  test('capture notation for pawns and pieces', () => {
    const c = new Chess();
    c.move('e4'); c.move('d5');
    assert.equal(c.move('exd5').san, 'exd5');
    assert.equal(c.move('Qxd5').san, 'Qxd5');
  });
});

describe('game status', () => {
  test("fool's mate", () => {
    const c = new Chess();
    for (const m of ['f3', 'e5', 'g4', 'Qh4#']) c.move(m);
    assert.deepEqual(c.status(), { over: true, result: '0-1', reason: 'checkmate', winner: 'b', check: true });
    assert.ok(c.isGameOver());
    assert.deepEqual(c.moves(), []);
  });
  test('stalemate', () => {
    const c = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    assert.ok(c.isStalemate());
    assert.ok(!c.isCheckmate());
    assert.equal(c.status().reason, 'stalemate');
  });
  test('insufficient material', () => {
    assert.ok(new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1').isInsufficientMaterial());
    assert.ok(new Chess('4k3/8/8/8/8/8/8/4KB2 w - - 0 1').isInsufficientMaterial());
    assert.ok(new Chess('4k3/8/8/8/8/8/8/4KN2 w - - 0 1').isInsufficientMaterial());
    assert.ok(new Chess('4k3/3b4/8/8/8/8/8/4KB2 w - - 0 1').isInsufficientMaterial(), 'bishops on same color (d7, f1 light)');
    assert.ok(!new Chess('4k3/2b5/8/8/8/8/8/4KB2 w - - 0 1').isInsufficientMaterial(), 'bishops on opposite colors (c7 dark, f1 light)');
    assert.ok(!new Chess('4k3/8/8/8/8/8/8/4KNN1 w - - 0 1').isInsufficientMaterial(), 'two knights can mate in theory');
    assert.ok(!new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').isInsufficientMaterial());
  });
  test('threefold repetition', () => {
    const c = new Chess();
    const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
    for (const m of cycle) c.move(m); // position occurred twice
    assert.ok(!c.isThreefoldRepetition());
    for (const m of cycle) c.move(m); // three times
    assert.ok(c.isThreefoldRepetition());
    assert.equal(c.status().reason, 'repetition');
    c.undo();
    assert.ok(!c.isThreefoldRepetition());
  });
  test('fifty-move rule', () => {
    const c = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 99 80');
    assert.ok(!c.isFiftyMoves());
    c.move('Ra2');
    assert.ok(c.isFiftyMoves());
    assert.equal(c.status().reason, 'fifty');
  });
  test('capture or pawn move resets the half-move clock', () => {
    const c = new Chess('4k3/8/8/8/8/8/8/R3K3 w - - 50 80');
    c.move('Ra8+');
    assert.equal(c.halfMoves(), 51);
    c.move('Kf7'); c.move('Rb8');
    assert.equal(c.halfMoves(), 53);
    const d = new Chess();
    d.move('e4');
    assert.equal(d.halfMoves(), 0);
  });
});

describe('history and PGN', () => {
  test('history in SAN and verbose form', () => {
    const c = new Chess();
    c.move('e4'); c.move('c5'); c.move('Nf3');
    assert.deepEqual(c.history(), ['e4', 'c5', 'Nf3']);
    const v = c.history({ verbose: true });
    assert.equal(v[1].from, 'c7');
    assert.equal(v[1].to, 'c5');
    assert.equal(v[2].after, c.fen());
  });
  test('pgn export and import round-trip', () => {
    const c = new Chess();
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']) c.move(m);
    const pgn = c.pgn({ headers: { White: 'A', Black: 'B' } });
    assert.match(pgn, /\[White "A"\]/);
    assert.match(pgn, /1\. e4 e5 2\. Nf3 Nc6 3\. Bb5 a6 4\. Ba4 Nf6 5\. O-O \*/);
    const d = new Chess();
    const headers = d.loadPgn(pgn);
    assert.equal(headers.White, 'A');
    assert.equal(d.fen(), c.fen());
  });
  test('pgn import strips comments, variations and NAGs', () => {
    const d = new Chess();
    d.loadPgn('1. e4 {best by test} e5 $1 2. Nf3 (2. f4 exf4) Nc6 1/2-1/2');
    assert.deepEqual(d.history(), ['e4', 'e5', 'Nf3', 'Nc6']);
  });
  test('pgn with custom start position', () => {
    const c = new Chess('4k3/8/4K3/8/8/8/8/R7 w - - 0 1');
    c.move('Ra8#');
    const pgn = c.pgn();
    assert.match(pgn, /\[FEN "4k3\/8\/4K3/);
    assert.match(pgn, /1\. Ra8# 1-0/);
    const d = new Chess();
    d.loadPgn(pgn);
    assert.ok(d.isCheckmate());
  });
  test('pgn import rejects illegal moves', () => {
    assert.throws(() => new Chess().loadPgn('1. e4 e5 2. Ke2 Qh4 3. Ka1'), /Недопустимый ход/);
  });
  test('clone is independent', () => {
    const c = new Chess();
    c.move('e4');
    const d = c.clone();
    d.move('e5');
    assert.equal(c.turn(), 'b');
    assert.equal(d.turn(), 'w');
    assert.deepEqual(d.history(), ['e4', 'e5']);
  });
});

describe('zobrist hash consistency', () => {
  test('incremental hash equals recomputed hash through a long random game', () => {
    const c = new Chess();
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 300 && !c.isGameOver(); i++) {
      const moves = c.moves({ verbose: true });
      const m = moves[Math.floor(rnd() * moves.length)];
      c.move(m);
      const fresh = new Chess(c.fen());
      assert.equal(c.internal.hashLo, fresh.internal.hashLo, `hashLo after ${m.san}`);
      assert.equal(c.internal.hashHi, fresh.internal.hashHi, `hashHi after ${m.san}`);
    }
  });
});
