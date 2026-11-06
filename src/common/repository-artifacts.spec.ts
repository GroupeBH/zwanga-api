import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Uses the existing test stage; never reads or prints artifact contents.
describe('repository infrastructure secret hygiene', () => {
  it('does not track Terraform state, plans or private key files', () => {
    const root = resolve(__dirname, '../..').replaceAll('\\', '/');
    const paths = execFileSync(
      'git',
      ['-c', `safe.directory=${root}`, 'ls-files', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ).split('\0');
    expect(
      paths.filter((path) =>
        /(?:^|\/)(?:tfplan(?:\..*)?|terraform\.tfstate(?:\..*)?)$|\.(?:tfplan|tfstate|p8|p12|pfx)$|(?:^|\/)\.terraform\//i.test(
          path,
        ),
      ),
    ).toEqual([]);
  });
});
