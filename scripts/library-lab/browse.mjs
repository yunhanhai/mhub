// Pure view derivation. These choices never modify player order or grant access.
export const BROWSE_PAGE_SIZE = 24;
export const BROWSE_SORTS = ['source', 'title', 'artist', 'album', 'duration'];
const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
const label = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
export const searchableText = value => label(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('zh-Hans');
export const albumKey = track => JSON.stringify([label(track?.album)]);
export const safeBrowseSort = value => BROWSE_SORTS.includes(value) ? value : 'source';

export function albumChoices(items) {
  const choices = new Map();
  for (const item of items) {
    const key = albumKey(item);
    if (!choices.has(key)) choices.set(key, { value: key, label: label(item.album) || '未标注专辑', count: 0 });
    choices.get(key).count++;
  }
  return [...choices.values()].sort((a, b) => collator.compare(a.label, b.label));
}

const numberOrLast = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Infinity;
const compareNumber = (a, b) => a === b ? 0 : a < b ? -1 : 1;
export function browseTracks(items, { query = '', format = '', album = '', savedOnly = false, sort = 'source' } = {}, savedKeys = new Set(), keyFor = item => item.id) {
  const words = searchableText(query).split(' ').filter(Boolean);
  const result = items.map((track, index) => ({ track, index })).filter(({ track }) => {
    if (format && String(track.format || '').toLowerCase() !== format) return false;
    if (album && albumKey(track) !== album) return false;
    if (savedOnly && !savedKeys.has(keyFor(track))) return false;
    const haystack = [track.title, track.artist, track.album].map(searchableText).join(' ');
    return words.every(word => haystack.includes(word));
  });
  sort = safeBrowseSort(sort);
  if (sort !== 'source') result.sort((a, b) => {
    const left = a.track, right = b.track;
    let compared;
    if (sort === 'duration') compared = compareNumber(numberOrLast(left.duration), numberOrLast(right.duration));
    else if (sort === 'album') compared = collator.compare(label(left.album), label(right.album))
      || compareNumber(numberOrLast(left.trackNumber), numberOrLast(right.trackNumber));
    else compared = collator.compare(label(left[sort]), label(right[sort]));
    return compared || a.index - b.index;
  });
  return result.map(item => item.track);
}
