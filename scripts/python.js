import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const virtualEnvironmentPython = path.join(
  projectRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);
const python = process.env.PYTHON || virtualEnvironmentPython;

if (!existsSync(python)) {
  console.error(
    `Python interpreter not found at "${python}". Create the project environment with "py -3.13 -m venv .venv" and install backend\\requirements.txt.`
  );
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
