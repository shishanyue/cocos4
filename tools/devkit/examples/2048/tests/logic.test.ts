import { test } from 'node:test';
import { deepEqual, equal, fail, notEqual } from 'node:assert/strict';
import { createGame, hasWon, isGameOver, moveBoard, parseGame, playMove, spawnTile } from '../src/logic.js';
import type { Direction, GameState } from '../src/logic.js';

function grid(...values: number[]): number[] {
    return [...values, ...Array<number>(16 - values.length).fill(0)];
}

test('compresses gaps, merges each tile once, and sums the merged values', () => {
    const result = moveBoard(grid(
        2, 2, 2, 2,
        4, 4, 8, 0,
        2, 0, 2, 2,
    ), 'left');
    deepEqual(result.board, grid(
        4, 4, 0, 0,
        8, 8, 0, 0,
        4, 2, 0, 0,
    ));
    equal(result.gained, 20);
    equal(result.changed, true);
});

test('moves toward the correct edge in all four directions', () => {
    const board = grid(2, 0, 2, 4, 0, 4, 4, 0, 2, 0, 2, 4, 0, 0, 0, 4);
    const cases: [Direction, number[], number][] = [
        ['left',  grid(4, 4, 0, 0, 8, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0, 0), 16],
        ['right', grid(0, 0, 4, 4, 0, 0, 0, 8, 0, 0, 4, 4, 0, 0, 0, 4), 16],
        ['up',    grid(4, 4, 2, 8, 0, 0, 4, 4, 0, 0, 2, 0, 0, 0, 0, 0), 12],
        ['down',  grid(0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 4, 4, 4, 2, 8), 12],
    ];
    for (const [direction, expected, gained] of cases) {
        const result = moveBoard(board, direction);
        deepEqual(result.board, expected, direction);
        equal(result.gained, gained, direction);
    }
});

test('copies frozen inputs and does not spawn or count a no-op', () => {
    const state: GameState = { version: 1, board: grid(2), score: 8, best: 20, moves: 3 };
    const before = { ...state, board: [...state.board] };
    Object.freeze(state.board);
    Object.freeze(state);
    const unchanged = playMove(state, 'left', () => fail('A no-op must not draw randomness'));
    deepEqual(unchanged, before);
    notEqual(unchanged.board, state.board);
    equal(moveBoard(state.board, 'left').changed, false);
    const changed = playMove(state, 'right', () => 0);
    deepEqual(changed.board, grid(2, 0, 0, 2));
    equal(changed.score, 8);
    equal(changed.moves, 4);
    deepEqual(state, before);
});

test('a changed move scores, updates best, and spawns exactly one tile', () => {
    const state: GameState = { version: 1, board: grid(2, 2), score: 20, best: 20, moves: 7 };
    let draws = 0;
    const next = playMove(state, 'left', () => { draws++; return 0; });
    deepEqual(next, { version: 1, board: grid(4, 2), score: 24, best: 24, moves: 8 });
    equal(draws, 2);
    equal(playMove({ ...state, best: 100 }, 'left', () => 0).best, 100);
});

test('spawning is deterministic, respects the 90/10 boundary, and leaves full boards alone', () => {
    const empty = grid();
    const rolls = [0.5, 0.9];
    const spawned = spawnTile(empty, () => rolls.shift()!);
    deepEqual(spawned, grid(0, 0, 0, 0, 0, 0, 0, 0, 4));
    equal(spawnTile(empty, () => 0.899999)[14], 2);
    deepEqual(empty, grid());
    const full = Array<number>(16).fill(2);
    deepEqual(spawnTile(full, () => fail('A full board cannot spawn')), full);
});

test('a fresh game has two tiles and keeps the previous best', () => {
    deepEqual(createGame(120, () => 0), {
        version: 1, board: grid(2, 2), score: 0, best: 120, moves: 0,
    });
});

test('recognizes wins and only ends a full board with no adjacent equal tiles', () => {
    const full = grid(2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 4, 8, 16, 32, 64);
    equal(isGameOver(full), true);
    const open = [...full];
    open[0] = 0;
    equal(isGameOver(open), false);
    const horizontal = [...full];
    horizontal[1] = 2;
    equal(isGameOver(horizontal), false);
    const vertical = [...full];
    vertical[4] = 2;
    equal(isGameOver(vertical), false);
    equal(hasWon(full), false);
    equal(hasWon(moveBoard(grid(1024, 1024), 'left').board), true);
    equal(hasWon(grid(4096)), true);
});

test('restores versioned state and ignores malformed saves', () => {
    const state = createGame(32, () => 0);
    deepEqual(parseGame(JSON.stringify(state)), state);
    equal(parseGame(null), null);
    equal(parseGame('{broken'), null);
    equal(parseGame(JSON.stringify({ ...state, version: 2 })), null);
    equal(parseGame(JSON.stringify({ ...state, board: [2] })), null);
    equal(parseGame(JSON.stringify({ ...state, board: grid(3) })), null);
    equal(parseGame(JSON.stringify({ ...state, board: grid() })), null);
    equal(parseGame(JSON.stringify({ ...state, moves: -1 })), null);
    equal(parseGame(JSON.stringify({ ...state, score: 64, best: 32 })), null);
});
