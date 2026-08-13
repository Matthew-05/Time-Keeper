/**
 * Start the sample-data server, run the page test against it, shut it down.
 *
 * The test needs a real Flask response for the template, so this owns the
 * process rather than expecting one to be running. `pipenv run` because that's
 * how Python is invoked everywhere in this project.
 */
import { spawn } from 'node:child_process';

/* pipenv everywhere by default, per the project's tooling rule. TK_PYTHON is
   the escape hatch for an environment that already has the deps on its path. */
const PYTHON = process.env.TK_PYTHON
    ? { cmd: process.env.TK_PYTHON, args: [] }
    : { cmd: 'pipenv', args: ['run', 'python'] };

const server = spawn(PYTHON.cmd, [...PYTHON.args, "tests/fixtures_add_task_page.py"], {
    stdio: ['ignore', 'pipe', 'inherit'],
});

const shutdown = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

/** Poll rather than sleep: a cold SQLite open is much slower than a warm one. */
async function waitForServer(attempts = 60) {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch('http://127.0.0.1:5099/clients');
            if (response.ok) return;
        } catch { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('sample-data server did not start');
}

await waitForServer();

const test = spawn(process.execPath, ['tests/test_add_task_page.mjs'], { stdio: 'inherit' });
test.on('exit', (code) => { shutdown(); process.exit(code ?? 1); });
