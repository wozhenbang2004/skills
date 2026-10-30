import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneRepo } from '../src/git.ts';

vi.mock('simple-git', async () => {
  const actual = await vi.importActual<typeof import('simple-git')>('simple-git');
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  return {
    ...actual,
    default: (options: Partial<import('simple-git').SimpleGitOptions>) => {
      const client = actual.default(options).outputHandler((command, _stdout, stderr, args) => {
        console.error('Git invocation:', command, args);
        stderr.on('data', (data) => console.error(data.toString()));
      });
      const checkout = client.checkout.bind(client);
      client.checkout = (async (ref: string) => {
        const gitDir = (await client.raw(['rev-parse', '--absolute-git-dir'])).trim();
        console.error(
          'Effective longpaths:',
          await client.raw(['config', '--show-origin', '--get-all', 'core.longpaths'])
        );
        console.error('Temporary repository config:', await readFile(join(gitDir, 'config'), 'utf8'));
        return checkout(ref);
      }) as typeof client.checkout;
      return client;
    },
  };
});

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

describe('cloneRepo long paths', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each([false, true])('checks out long paths (pinned=%s)', async (pinned) => {
    const root = await mkdtemp(join(tmpdir(), 'skills-long-path-test-'));
    tempDirs.push(root);
    const source = join(root, 'source');
    const globalConfig = join(root, 'global.gitconfig');
    const configContents = '[core]\n  longpaths = false\n';
    await writeFile(globalConfig, configContents);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '0');

    await runGit(['init', source]);
    await runGit(['config', 'user.email', 'skills-test@example.com'], source);
    await runGit(['config', 'user.name', 'Skills Test'], source);
    const relativePath = join(
      ...Array.from({ length: 6 }, (_, index) => `part-${index}-${'x'.repeat(35)}`),
      'SKILL.md'
    );
    expect(relativePath.length).toBeGreaterThan(260);
    const contents = '---\nname: long-path-skill\ndescription: Regression fixture\n---\n';
    // Build the Git tree without traversing a long source working tree.
    const fixtureFile = join(root, 'fixture.md');
    await writeFile(fixtureFile, contents);
    const blob = (await runGit(['hash-object', '-w', fixtureFile], source)).trim();
    await runGit(
      ['update-index', '--add', '--cacheinfo', `100644,${blob},${relativePath.split(sep).join('/')}`],
      source
    );
    const tree = (await runGit(['write-tree'], source)).trim();
    const sha = (await runGit(['commit-tree', tree, '-m', 'fixture'], source)).trim();
    await runGit(['update-ref', 'HEAD', sha], source);
    expect((await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], source)).trim()).toBe(
      relativePath.split(sep).join('/')
    );

    const cloneDir = await cloneRepo(source, pinned ? sha : undefined);
    tempDirs.push(cloneDir);

    expect(await readFile(join(cloneDir, relativePath), 'utf8')).toBe(contents);
    expect(await readFile(globalConfig, 'utf8')).toBe(configContents);
    expect((await runGit(['config', '--global', '--get', 'core.longpaths'])).trim()).toBe('false');
  }, 20_000);
});
