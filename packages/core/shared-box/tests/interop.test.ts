import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import {generateKeyPair,seal,open,clearSharedBoxKeys} from '../../crypto';
import {createSharedBoxCache} from '..';

const bytes=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
test('precomputed boxes remain byte-for-byte compatible with direct NaCl in both directions',()=>{
  const alice=generateKeyPair(),bob=generateKeyPair(),payload={text:'Synthetic interoperability payload'};
  const sealed=seal(payload,bob.publicKey,alice.secretKey),nonce=bytes(sealed.nonce);
  const reference=nacl.box(new TextEncoder().encode(JSON.stringify(payload)),nonce,bytes(bob.publicKey),bytes(alice.secretKey));
  assert.deepEqual(bytes(sealed.box),reference);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(nacl.box.open(bytes(sealed.box),nonce,bytes(alice.publicKey),bytes(bob.secretKey))!)),payload);
  assert.deepEqual(open(sealed.nonce,Buffer.from(reference).toString('base64'),alice.publicKey,bob.secretKey),payload);
  clearSharedBoxKeys();assert.deepEqual(open(sealed.nonce,sealed.box,alice.publicKey,bob.secretKey),payload);
});

test('rotation, ciphertext tampering and malformed keys retain authentication, while nonces stay fresh',()=>{
  const alice=generateKeyPair(),bob=generateKeyPair(),other=generateKeyPair(),nonces=new Set<string>();
  for(let n=0;n<32;n++){const e=seal({n},bob.publicKey,alice.secretKey);nonces.add(e.nonce);assert.deepEqual(open(e.nonce,e.box,alice.publicKey,bob.secretKey),{n})}
  assert.equal(nonces.size,32);
  const e=seal({private:true},bob.publicKey,other.secretKey);
  assert.equal(open(e.nonce,e.box,alice.publicKey,bob.secretKey),null);
  assert.deepEqual(open(e.nonce,e.box,other.publicKey,bob.secretKey),{private:true});
  assert.equal(open(e.nonce,e.box,other.publicKey,alice.secretKey),null);
  const corrupt=Buffer.from(e.box,'base64');corrupt[0]=corrupt[0]!^1;assert.equal(open(e.nonce,corrupt.toString('base64'),other.publicKey,bob.secretKey),null);
  assert.equal(open(e.nonce,e.box,'invalid',bob.secretKey),null);
  assert.throws(()=>seal({},bob.publicKey,'invalid'),/key size/);
});

test('the bounded cache derives once per key pair and erases evicted, expired and cleared secrets',()=>{
  const alice=generateKeyPair(),bob=generateKeyPair(),other=generateKeyPair();let now=0,calls=0,scratch:Uint8Array|undefined;
  const cache=createSharedBoxCache({capacity:1,ttlMs:10,now:()=>now,derive:(_pub,secret)=>{scratch=secret;return new Uint8Array(32).fill(++calls)}});
  const first=cache.get(bob.publicKey,alice.secretKey);assert.equal(calls,1);assert.ok(scratch!.every(b=>b===0));
  assert.equal(cache.get(bob.publicKey,alice.secretKey),first);assert.equal(calls,1);
  const second=cache.get(other.publicKey,alice.secretKey);assert.equal(calls,2);assert.ok(first.every(b=>b===0));
  now=11;const renewed=cache.get(other.publicKey,alice.secretKey);assert.equal(calls,3);assert.ok(second.every(b=>b===0));
  cache.clear();assert.ok(renewed.every(b=>b===0));
  assert.throws(()=>cache.get('invalid',alice.secretKey),/public key size/);
  assert.throws(()=>cache.get(bob.publicKey,'invalid'),/secret key size/);
});
