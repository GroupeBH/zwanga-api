import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { createServer } from 'net';
import { DataSource } from 'typeorm';

/** Explicit test binaries, fresh loopback cluster; never reads application configuration. */
export class IsolatedPostgres {
  private directory?: string;
  source?: DataSource;
  constructor(private readonly bin: string) {}
  private executable(name: string) {
    return join(this.bin, process.platform === 'win32' ? `${name}.exe` : name);
  }
  async start(): Promise<DataSource> {
    this.directory = mkdtempSync(join(tmpdir(), 'zwanga-audit-test-'));
    try {
      execFileSync(
        this.executable('initdb'),
        [
          '-D',
          this.directory,
          '-U',
          'audit_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 60000 },
      );
      const port = await new Promise<number>((done, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const value = (server.address() as { port: number }).port;
          server.close(() => done(value));
        });
      });
      execFileSync(
        this.executable('pg_ctl'),
        [
          '-D',
          this.directory,
          '-l',
          join(this.directory, 'postgres.log'),
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start',
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
      this.source = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'audit_test',
        database: 'postgres',
        extra: { max: 8 },
      });
      return await this.source.initialize();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (this.source?.isInitialized) await this.source.destroy();
    if (!this.directory) return;
    const target = resolve(this.directory);
    if (!target.startsWith(resolve(tmpdir()) + sep + 'zwanga-audit-test-'))
      throw new Error('Unsafe test cleanup target');
    if (existsSync(join(target, 'postmaster.pid')))
      execFileSync(
        this.executable('pg_ctl'),
        ['-D', target, '-m', 'fast', '-w', 'stop'],
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
    rmSync(target, { recursive: true, force: true });
    this.directory = undefined;
  }
}
