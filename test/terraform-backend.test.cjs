'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

test('production backend example points at the existing state, not a parallel empty stack', () => {
  const read = file => readFileSync(`infra-aws/${file}`, 'utf8');
  const value = (source, name) => {
    const matches = [...source.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*("[^"\\r\\n]+"|true|false)\\s*$`, 'gm'))];
    assert.equal(matches.length, 1, `Expected one ${name} assignment`);
    return JSON.parse(matches[0][1]);
  };
  const actual = read('backend.tf');
  const example = read('backend.hcl.example');
  const expected = {
    bucket: 'tfstates-zwanga-api',
    key: 'zwanga/ecs-fargate/eu-central-1/terraform.tfstate',
    region: 'eu-central-1',
    encrypt: true,
    use_lockfile: true,
  };
  for (const [name, wanted] of Object.entries(expected)) {
    assert.equal(value(actual, name), wanted, name);
    assert.equal(value(example, name), wanted, `Example drift: ${name}`);
  }
});
