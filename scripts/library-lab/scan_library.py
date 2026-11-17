#!/usr/bin/env python3
"""Read original music files and prepare a reviewable, private library policy candidate.

Requires ffprobe and ffmpeg on PATH. Never edits audio, grants access, deletes
existing policy entries or applies its output to a running service.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import unicodedata

MAX_AUDIO = 32 * 1024 * 1024
MAX_COVER = 64 * 1024
MAX_ITEMS = 100
EXTENSIONS = {'.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav'}


def read_json(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def text(value, limit=512):
    value = unicodedata.normalize('NFC', str(value or ''))
    value = ''.join(character for character in value if unicodedata.category(character) not in {'Cc', 'Cf'})
    return value.strip()[:limit]


def run(command, input_bytes=None, timeout=20):
    result = subprocess.run(command, input=input_bytes, capture_output=True, timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise ValueError('media tool rejected this file')
    return result.stdout


def fingerprint(file):
    stat = file.stat()
    return (stat.st_size, stat.st_mtime_ns, stat.st_ino)


def hash_file(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def probe(file, ffprobe):
    raw = run([ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
               'format=duration:format_tags=title,artist,album,album_artist,date,track:stream=index,codec_type,codec_name,width,height:stream_disposition=attached_pic',
               '-of', 'json', str(file)])
    if len(raw) > 128 * 1024:
        raise ValueError('metadata response exceeds limit')
    return json.loads(raw)


def extract_artwork(file, info, ffmpeg, ffprobe):
    pictures = [stream for stream in info.get('streams', []) if stream.get('disposition', {}).get('attached_pic')]
    if not pictures:
        return None, None
    picture = pictures[0]
    width, height = int(picture.get('width', 0)), int(picture.get('height', 0))
    if width <= 0 or height <= 0 or width * height > 20_000_000:
        raise ValueError('embedded artwork dimensions exceed limit')
    data = run([ffmpeg, '-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', str(file), '-map', '0:' + str(picture['index']),
                '-frames:v', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=decrease',
                '-filter_threads', '1', '-map_metadata', '-1', '-threads', '1', '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'])
    if not 4 <= len(data) <= MAX_COVER or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise ValueError('embedded artwork cannot be reduced to a bounded JPEG')
    dimensions = json.loads(run([ffprobe, '-v', 'error', '-i', 'pipe:0', '-show_entries',
                                 'stream=width,height', '-of', 'json'], input_bytes=data))['streams'][0]
    return {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
            'width': dimensions['width'], 'height': dimensions['height'], 'contentType': 'image/jpeg'}, data


def scan_file(file, relative, ffprobe, ffmpeg):
    before = fingerprint(file)
    if before[0] == 0 or before[0] > MAX_AUDIO:
        raise ValueError('audio size is outside the current library limit')
    info = probe(file, ffprobe)
    audio = [stream for stream in info.get('streams', []) if stream.get('codec_type') == 'audio']
    if len(audio) != 1:
        raise ValueError('file must contain one audio stream')
    codec = audio[0].get('codec_name', '')
    supported = codec in {'mp3', 'flac'} and file.suffix.lower() == '.' + codec
    tags = {key.lower(): value for key, value in info.get('format', {}).get('tags', {}).items()}
    seconds = float(info.get('format', {}).get('duration', 0))
    if not math.isfinite(seconds) or not 0 < seconds <= 24 * 60 * 60:
        raise ValueError('audio duration is invalid')
    version = hash_file(file)
    artwork, cover = extract_artwork(file, info, ffmpeg, ffprobe)
    if fingerprint(file) != before or hash_file(file) != version:
        raise ValueError('file changed while being scanned; scan again')
    number = re.match(r'^\s*(\d{1,4})(?:/\d+)?\s*$', str(tags.get('track', '')))
    year = re.match(r'^(\d{4})(?:\D|$)', str(tags.get('date', '')))
    record = {'path': relative, 'title': text(tags.get('title')) or text(file.stem),
              'artist': text(tags.get('artist')), 'album': text(tags.get('album')),
              'albumArtist': text(tags.get('album_artist')), 'duration': round(seconds * 1000),
              'format': codec, 'contentType': {'mp3': 'audio/mpeg', 'flac': 'audio/flac'}.get(codec, ''),
              'size': before[0], 'sha256': version,
              'modifiedAt': dt.datetime.fromtimestamp(before[1] / 1e9, dt.timezone.utc).isoformat(),
              'supported': supported, 'trackNumber': int(number[1]) if number else None,
              'year': int(year[1]) if year and int(year[1]) >= 1000 else None, 'artwork': artwork}
    return record, cover


def relative_name(value):
    name = PurePosixPath(str(value).replace('\\', '/'))
    if name.is_absolute() or '..' in name.parts or not name.parts or ':' in str(name):
        raise ValueError('binding paths must be relative to the music root')
    return name.as_posix()


def candidate_policy(inventory, binding, previous):
    if not isinstance(binding, dict) or not isinstance(binding.get('files', []), list):
        raise ValueError('binding must contain a list of files')
    if previous is not None and (not isinstance(previous, dict) or not isinstance(previous.get('tracks', []), list)):
        raise ValueError('previous policy must contain a list of tracks')
    instance = binding.get('instanceId')
    if not isinstance(instance, str) or not 1 <= len(instance) <= 128:
        raise ValueError('binding instanceId is invalid')
    if previous and previous.get('instanceId') != instance:
        raise ValueError('existing policy belongs to a different instance')
    old = {entry['songId']: entry for entry in (previous or {}).get('tracks', [])}
    if len(old) != len((previous or {}).get('tracks', [])):
        raise ValueError('existing policy has duplicate song IDs')
    entries = dict(old)
    records = {record['path']: record for record in inventory}
    used_paths, used_ids, changes = set(), set(), []
    for item in binding.get('files', []):
        if not isinstance(item, dict) or not isinstance(item.get('path'), str):
            raise ValueError('each binding needs a relative path and song ID')
        name, song = relative_name(item['path']), item.get('songId')
        if not isinstance(song, str) or not 1 <= len(song) <= 256 or name in used_paths or song in used_ids:
            raise ValueError('binding has invalid or duplicate path/song ID')
        used_paths.add(name); used_ids.add(song)
        record = records.get(name)
        if record is None or not record['supported']:
            raise ValueError('a bound original is missing or uses an unsupported format')
        original = old.get(song)
        entry = dict(original or {})
        entry.update({key: record[key] for key in ['title', 'artist', 'album', 'duration', 'format', 'contentType',
                                                  'size', 'sha256', 'modifiedAt', 'trackNumber', 'year', 'artwork']})
        entry.update({'songId': song, 'access': original['access'] if original else 'restricted',
                      'allowedUserIds': list(original.get('allowedUserIds', [])) if original else []})
        # Binding cannot silently introduce a grant or change the existing one.
        if any(key in item for key in ['access', 'allowedUserIds']):
            raise ValueError('access grants do not belong in file bindings')
        entries[song] = entry
        reasons = []
        if not original:
            reasons.append('added_restricted')
        else:
            if original.get('sha256') != entry['sha256']:
                reasons.append('file_version_changed')
            if any(original.get(key) != entry.get(key) for key in ['title', 'artist', 'album', 'duration', 'trackNumber', 'year']):
                reasons.append('metadata_changed')
            if original.get('artwork') != entry.get('artwork'):
                reasons.append('artwork_changed')
        changes.append({'songId': song, 'path': name, 'reasons': reasons or ['unchanged'],
                        'accessPreserved': bool(original), 'oldSHA256': original.get('sha256') if original else None,
                        'newSHA256': entry['sha256']})
    if len(entries) > MAX_ITEMS or sum(entry['size'] for entry in entries.values()) > 128 * 1024 * 1024:
        raise ValueError('candidate exceeds current backend catalogue limits')
    ordered = [entries[entry['songId']] for entry in (previous or {}).get('tracks', [])]
    ordered += [entries[song] for song in sorted(set(entries) - set(old))]
    policy = {'instanceId': instance, 'tracks': ordered}
    if previous and 'revision' in previous:
        policy['revision'] = previous['revision']
    return policy, {'changes': changes, 'preservedUnboundSongIds': sorted(set(old) - used_ids),
                    'unboundFiles': sorted(set(records) - used_paths), 'automaticDeletions': 0, 'automaticGrants': 0}


def scan(root, output, bindings=None, previous=None, ffprobe='ffprobe', ffmpeg='ffmpeg'):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('music root must be a real directory')
    root = root.resolve()
    output = output.resolve()
    if output == root or root in output.parents:
        raise ValueError('output must be outside the original music root')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'artwork').mkdir()
    inventory, errors, skipped = [], [], []
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(name for name in directories if not (Path(directory) / name).is_symlink()
                                and not getattr(Path(directory) / name, 'is_junction', lambda: False)())
        for name in sorted(files):
            file = Path(directory) / name
            if file.suffix.lower() not in EXTENSIONS:
                continue
            relative = file.relative_to(root).as_posix()
            if file.is_symlink():
                skipped.append({'path': relative, 'reason': 'symbolic_link'}); continue
            try:
                record, cover = scan_file(file, relative, ffprobe, ffmpeg)
                inventory.append(record)
                if cover is not None:
                    target = output / 'artwork' / (record['artwork']['sha256'] + '.jpg')
                    if not target.exists():
                        with target.open('xb') as stream:
                            stream.write(cover)
            except (OSError, ValueError, subprocess.TimeoutExpired, KeyError) as error:
                errors.append({'path': relative, 'reason': 'probe_or_integrity_failed', 'detail': str(error) if isinstance(error, ValueError) else 'media inspection failed'})
    report = {'recordedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'root': str(root),
              'files': inventory, 'errors': errors, 'skipped': skipped, 'audioFilesModified': False}
    with (output / 'inventory.json').open('x', encoding='utf-8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    if errors:
        return {'passed': False, 'files': len(inventory), 'errors': len(errors), 'candidateWritten': False}
    if bindings:
        policy, changes = candidate_policy(inventory, read_json(bindings), read_json(previous) if previous else None)
        for name, value in [('candidate-policy.json', policy), ('changes.json', changes)]:
            with (output / name).open('x', encoding='utf-8') as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
    return {'passed': True, 'files': len(inventory), 'unsupported': len([item for item in inventory if not item['supported']]),
            'artworkFiles': len(list((output / 'artwork').iterdir())), 'candidateWritten': bool(bindings), 'applied': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bindings', type=Path)
    parser.add_argument('--previous-policy', type=Path)
    parser.add_argument('--ffprobe', default='ffprobe')
    parser.add_argument('--ffmpeg', default='ffmpeg')
    args = parser.parse_args()
    try:
        result = scan(args.root, args.output, args.bindings, args.previous_policy, args.ffprobe, args.ffmpeg)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['passed'] else 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
        print(json.dumps({'passed': False, 'reason': 'scan refused; check paths, bindings and media tools', 'applied': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
