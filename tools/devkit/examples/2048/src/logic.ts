export type Direction = 'left' | 'right' | 'up' | 'down';

export interface GameState {
    version: 1;
    board: number[];
    score: number;
    best: number;
    moves: number;
}

export interface MoveResult {
    board: number[];
    gained: number;
    changed: boolean;
}

// Row-major, top row first. Read each line starting at its destination edge.
export function moveBoard(board: readonly number[], direction: Direction): MoveResult {
    const next = Array<number>(16).fill(0);
    let gained = 0;
    for (let line = 0; line < 4; line++) {
        const indices = Array.from({ length: 4 }, (_, offset) => {
            if (direction === 'left') return line * 4 + offset;
            if (direction === 'right') return line * 4 + 3 - offset;
            if (direction === 'up') return offset * 4 + line;
            return (3 - offset) * 4 + line;
        });
        const packed = indices.map(index => board[index]!).filter(value => value !== 0);
        const merged: number[] = [];
        for (let i = 0; i < packed.length; i++) {
            let value = packed[i]!;
            if (value === packed[i + 1]) {
                value *= 2;
                gained += value;
                i++;
            }
            merged.push(value);
        }
        indices.forEach((index, offset) => { next[index] = merged[offset] ?? 0; });
    }
    return { board: next, gained, changed: next.some((value, index) => value !== board[index]) };
}

// Random draws are in [0, 1): empty-cell selection first, then the tile value.
export function spawnTile(board: readonly number[], random: () => number = Math.random): number[] {
    const next = [...board];
    const empty = board.map((value, index) => value === 0 ? index : -1).filter(index => index >= 0);
    if (empty.length > 0) {
        const index = empty[Math.floor(random() * empty.length)]!;
        next[index] = random() < 0.9 ? 2 : 4;
    }
    return next;
}

export function createGame(best = 0, random: () => number = Math.random): GameState {
    const board = spawnTile(spawnTile(Array<number>(16).fill(0), random), random);
    return { version: 1, board, score: 0, best, moves: 0 };
}

export function playMove(state: Readonly<GameState>, direction: Direction, random: () => number = Math.random): GameState {
    const result = moveBoard(state.board, direction);
    if (!result.changed) return { ...state, board: result.board };
    const score = state.score + result.gained;
    return {
        version: 1,
        board: spawnTile(result.board, random),
        score,
        best: Math.max(state.best, score),
        moves: state.moves + 1,
    };
}

export function hasWon(board: readonly number[]): boolean {
    return board.some(value => value >= 2048);
}

export function isGameOver(board: readonly number[]): boolean {
    return !board.some((value, index) => value === 0
        || (index % 4 < 3 && value === board[index + 1])
        || (index < 12 && value === board[index + 4]));
}

function isCounter(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseGame(json: string | null): GameState | null {
    if (json === null) return null;
    try {
        const data: unknown = JSON.parse(json);
        if (typeof data !== 'object' || data === null) return null;
        const { version, board, score, best, moves } = data as Record<string, unknown>;
        if (version !== 1 || !Array.isArray(board) || board.length !== 16
            || !isCounter(score) || !isCounter(best) || !isCounter(moves) || best < score) return null;
        if (!board.every((value: unknown): value is number => typeof value === 'number'
            && Number.isSafeInteger(value)
            && (value === 0 || (value >= 2 && value === 2 ** Math.round(Math.log2(value)))))
            || !board.some(value => value > 0)) return null;
        return { version: 1, board: [...board], score, best, moves };
    } catch {
        return null;
    }
}
