import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerAddress } from '../src/address.ts';

test('bare LAN addresses get http and the default port', () => {
  assert.deepEqual(parseServerAddress('192.168.1.20'), {
    origin: 'http://192.168.1.20:8787',
    secure: false,
    privateNetwork: true,
  });
  assert.equal(
    parseServerAddress(' nas.local:9000 ').origin,
    'http://nas.local:9000',
  );
  assert.equal(parseServerAddress('10.0.0.5:8787').privateNetwork, true);
  assert.equal(parseServerAddress('100.101.102.103').privateNetwork, true);
});

test('https addresses keep their port and are marked secure', () => {
  const address = parseServerAddress('https://media.example.com');
  assert.equal(address.origin, 'https://media.example.com');
  assert.equal(address.secure, true);
  assert.equal(address.privateNetwork, false);
});

test('public plain-http hosts are flagged for a warning', () => {
  const address = parseServerAddress('http://media.example.com:8787');
  assert.equal(address.secure, false);
  assert.equal(address.privateNetwork, false);
});

test('credentials, paths and other schemes are rejected with plain messages', () => {
  assert.throws(() => parseServerAddress(''), /Enter your Shinema server/);
  assert.throws(() => parseServerAddress('http://user:pw@host'), /user name/);
  assert.throws(() => parseServerAddress('http://host/api'), /without a path/);
  assert.throws(
    () => parseServerAddress('ftp://host'),
    /http:\/\/ or https:\/\//,
  );
});
