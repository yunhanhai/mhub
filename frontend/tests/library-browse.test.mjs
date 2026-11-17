import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSE_PAGE_SIZE, albumChoices, albumKey, browseTracks, safeBrowseSort } from '../../scripts/library-lab/browse.mjs';

const track = (id, values = {}) => ({ id, title: id, artist: 'Artist', album: 'Album', format: 'flac', duration: 12000, ...values });
const ids = items => items.map(item => item.id);

test('query finds title, artist and album words together with case and accent normalization', () => {
  const items = [track('match', { title: 'Café 夜晚', artist: 'Moon Singer', album: '旅途 2026' }), track('other')];
  assert.deepEqual(ids(browseTracks(items, { query: 'ＣＡＦＥ moon 旅途' })), ['match']);
  assert.deepEqual(ids(browseTracks(items, { query: '旅途 missing' })), []);
  assert.deepEqual(ids(browseTracks(items, { query: '  ' })), ['match', 'other']);
});

test('format, album and saved status intersect using full representation keys', () => {
  const items = [track('saved', { format: 'mp3', album: 'Chosen' }), track('unsaved', { format: 'mp3', album: 'Chosen' }), track('wrong-format', { album: 'Chosen' })];
  assert.deepEqual(ids(browseTracks(items, { format: 'mp3', album: albumKey(items[0]), savedOnly: true }, new Set(['saved']))), ['saved']);
  assert.deepEqual(ids(browseTracks(items, { savedOnly: true }, new Set(['old-version']), item => item.id + ':current-version')), []);
});

test('album choices preserve punctuation, group normalized labels and count only supplied records', () => {
  const items = [track('one', { album: '  A  B ' }), track('two', { album: 'A B' }), track('three', { album: '"A/B"' }), track('missing', { album: '' })];
  const choices = albumChoices(items);
  assert.equal(choices.length, 3);
  assert.equal(choices.find(item => item.label === 'A B').count, 2);
  assert.ok(choices.some(item => item.label === '未标注专辑'));
  assert.deepEqual(ids(browseTracks(items, { album: albumKey(items[2]) })), ['three']);
});

test('sort is stable and does not mutate source, tracks or supplied queue order', () => {
  const source = [track('three', { title: 'Song 10' }), track('two', { title: 'Song 2' }), track('tie', { title: 'Song 2' })];
  const original = structuredClone(source);
  assert.deepEqual(ids(browseTracks(source, { sort: 'title' })), ['two', 'tie', 'three']);
  assert.deepEqual(ids(browseTracks(source, { sort: 'source' })), ['three', 'two', 'tie']);
  assert.deepEqual(source, original);
});

test('album sequence is ordered numerically and missing track numbers follow known ones', () => {
  const source = [track('ten', { album: 'B', trackNumber: 10 }), track('missing', { album: 'A' }), track('two', { album: 'A', trackNumber: 2 }), track('one', { album: 'A', trackNumber: 1 })];
  assert.deepEqual(ids(browseTracks(source, { sort: 'album' })), ['one', 'two', 'missing', 'ten']);
});

test('duration sorting puts invalid or unknown values last and retains ties', () => {
  const source = [track('unknown', { duration: NaN }), track('long', { duration: 60000 }), track('short', { duration: 1000 }), track('zero', { duration: 0 }), track('tie', { duration: 1000 })];
  assert.deepEqual(ids(browseTracks(source, { sort: 'duration' })), ['short', 'tie', 'long', 'unknown', 'zero']);
});

test('artist sort compares names without reordering equal artists', () => {
  const source = [track('last', { artist: 'Z' }), track('first', { artist: 'A' }), track('tie', { artist: 'A' })];
  assert.deepEqual(ids(browseTracks(source, { sort: 'artist' })), ['first', 'tie', 'last']);
});

test('unknown saved preference falls back to original order; full results exceed one visible batch', () => {
  assert.equal(safeBrowseSort('private-album-name'), 'source');
  assert.equal(safeBrowseSort(null), 'source');
  const source = Array.from({ length: 65 }, (_, index) => track('song-' + index));
  assert.ok(BROWSE_PAGE_SIZE < source.length);
  assert.equal(browseTracks(source, { sort: 'invalid' }).length, 65);
  assert.deepEqual(ids(browseTracks(source, { sort: 'invalid' })), ids(source));
});
