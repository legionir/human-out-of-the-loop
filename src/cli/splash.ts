/**
 * The start screen: the terminal is cleared and "HOOTL" is drawn in the
 * cfonts "block" style (solid blocks with a box-drawing shadow), yellow
 * with an orange (#f80) shadow, centered.  The four glyphs are drawn here
 * rather than pulling in a font library for them.
 */
import chalk from 'chalk';

const GLYPHS: Record<string, string[]> = {
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
};

/** Plain (uncolored) rows of a word; one column between letters. */
export function bigText(word: string): string[] {
  const glyphs = [...word.toUpperCase()].map((ch) => GLYPHS[ch]).filter((g): g is string[] => Boolean(g));
  const rows = glyphs[0]?.length ?? 0;
  return Array.from({ length: rows }, (_, r) => glyphs.map((g) => g[r]).join(' '));
}

/** Blocks in the face color, box-drawing characters in the shadow color. */
function paint(row: string, face: (s: string) => string, shadow: (s: string) => string): string {
  return row.replace(/(█+)|([^█ ]+)/g, (_m, block: string | undefined, edge: string | undefined) =>
    block ? face(block) : shadow(edge ?? ''),
  );
}

export interface SplashOptions {
  columns?: number;
  rows?: number;
  subtitle?: string;
}

/** The whole screen: clear, then the word centered (with a subtitle under it). */
export function renderSplash(opts: SplashOptions = {}): string {
  const columns = opts.columns ?? 80;
  const screenRows = opts.rows ?? 24;
  const lines = bigText('HOOTL');
  const width = lines[0]?.length ?? 0;
  const left = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
  const face = chalk.yellow;
  const shadow = chalk.hex('#ff8800');
  const body = lines.map((l) => left + paint(l, face, shadow));
  if (opts.subtitle) {
    const pad = ' '.repeat(Math.max(0, Math.floor((columns - opts.subtitle.length) / 2)));
    body.push('', pad + chalk.dim(opts.subtitle));
  }
  const top = Math.max(0, Math.floor((screenRows - body.length) / 2));
  // \x1b[2J clear, \x1b[3J scrollback, \x1b[H home
  return '\x1b[2J\x1b[3J\x1b[H' + '\n'.repeat(top) + body.join('\n') + '\n';
}

/** Show the splash for `ms` (or until any key), then clear the screen again. */
export async function showSplash(
  output: NodeJS.WriteStream,
  opts: { ms?: number; subtitle?: string; input?: NodeJS.ReadStream } = {},
): Promise<void> {
  output.write('\x1b[?25l'); // hide the cursor while the splash is up
  output.write(renderSplash({ columns: output.columns, rows: output.rows, subtitle: opts.subtitle }));
  const input = opts.input ?? (process.stdin as NodeJS.ReadStream);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', finish);
      if (wasRaw === false && input.isTTY) {
        try {
          input.setRawMode(false);
        } catch {
          // ignore
        }
      }
      resolve();
    };
    const timer = setTimeout(finish, opts.ms ?? 3000);
    let wasRaw: boolean | undefined;
    if (typeof input.setRawMode === 'function' && input.isTTY) {
      wasRaw = input.isRaw;
      try {
        input.setRawMode(true);
      } catch {
        wasRaw = undefined;
      }
      input.resume();
    }
    input.once('data', finish);
  });
  output.write('\x1b[2J\x1b[3J\x1b[H\x1b[?25h');
}
