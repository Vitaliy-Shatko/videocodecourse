#!/usr/bin/env node
/**
 * Perft benchmark / self-check for the move generator.
 *
 *   node scripts/perft.mjs                 (standard suite)
 *   node scripts/perft.mjs "<fen>" <depth>
 */
import { Chess, START_FEN } from '../chess/js/engine/chess.js';

const SUITE = [
  ['Start position', START_FEN, 5, 4865609],
  ['Kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 4, 4085603],
  ['Position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 5, 674624],
  ['Position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 4, 422333],
  ['Position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 4, 2103487],
  ['Position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', 4, 3894594],
];

function run(name, fen, depth, expected) {
  const chess = new Chess(fen);
  const start = performance.now();
  const nodes = chess.perft(depth);
  const ms = performance.now() - start;
  const ok = expected === undefined ? '' : nodes === expected ? 'OK' : `MISMATCH (expected ${expected})`;
  console.log(`${name.padEnd(16)} depth ${depth}: ${String(nodes).padStart(10)} nodes in ${ms.toFixed(0).padStart(5)} ms ` +
    `(${(nodes / ms / 1000).toFixed(2)} Mnps) ${ok}`);
  return ok !== '' && !ok.startsWith('OK') ? 1 : 0;
}

if (process.argv[2]) {
  process.exit(run('Custom', process.argv[2], Number(process.argv[3] || 3)));
} else {
  let failures = 0;
  for (const [name, fen, depth, expected] of SUITE) failures += run(name, fen, depth, expected);
  process.exit(failures ? 1 : 0);
}
