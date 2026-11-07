import assert from 'node:assert/strict';
import test from 'node:test';
import { plainPreview } from '../index';

test('headings, quotes, nested lists and line breaks remain separate words', () => {
  assert.equal(plainPreview('# Heading\n\n> Quote\n\n- One\n  - Two\n- Three\n\nLast  \nline'),
    'Heading Quote One Two Three Last line');
});

test('tables keep cell and row boundaries without separator syntax', () => {
  assert.equal(plainPreview('| Name | Value |\n| --- | --- |\n| **One** | `a*b` |\n| Two | 2 |'),
    'Name | Value One | a*b Two | 2');
});

test('inline and fenced code keep literal markup and entities', () => {
  assert.equal(plainPreview('`**literal** &amp;`\n\n```txt\na_b *c* <tag>\n```'),
    '**literal** &amp; a_b *c* <tag>');
});

test('reference links and images display labels, not destinations or definitions', () => {
  assert.equal(plainPreview('[Read **this**][guide] ![diagram](https://example.test/image.png)\n\n[guide]: https://example.test'),
    'Read this diagram');
});

test('entity decoding applies to prose without losing escaped punctuation', () => {
  assert.equal(plainPreview('A &amp; B &#x1F642; &copy; \\*literal\\*'), 'A & B 🙂 © *literal*');
});

test('HTML tags and a horizontal rule do not become preview syntax', () => {
  assert.equal(plainPreview('<div>Visible &amp; text</div>\n\n---\n\nAfter'), 'Visible & text After');
});

test('empty host markup stays empty and Unicode truncation does not split a character', () => {
  assert.equal(plainPreview(undefined), undefined);
  assert.equal(plainPreview('<timestamp>internal</timestamp>\n   '), undefined);
  assert.equal(plainPreview('**🙂🙂🙂**', 2), '🙂🙂');
});

test('adjacent formatting preserves word continuity', () => {
  assert.equal(plainPreview('pre**bold**post ~~old~~ _new_'), 'preboldpost old new');
});
