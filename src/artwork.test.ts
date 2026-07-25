import { describe, expect, it } from 'vitest';
import { safeEntityPicture, pictureBackground } from './artwork';

const HA = 'http://homeassistant.local:8123';

describe('safeEntityPicture', () => {
  it('resolves root-relative HA paths against the connection URL', () => {
    expect(safeEntityPicture('/api/image/serve/abc/512x512', HA))
      .toBe('http://homeassistant.local:8123/api/image/serve/abc/512x512');
    expect(safeEntityPicture('/local/grandma.jpg', HA))
      .toBe('http://homeassistant.local:8123/local/grandma.jpg');
  });

  it('does not double up the slash on a trailing-slash URL', () => {
    expect(safeEntityPicture('/local/x.jpg', 'http://ha.local:8123/'))
      .toBe('http://ha.local:8123/local/x.jpg');
  });

  it('passes absolute http(s) URLs through', () => {
    expect(safeEntityPicture('https://cdn.example.com/art.jpg', HA))
      .toBe('https://cdn.example.com/art.jpg');
  });

  it('rejects anything that could break out of url("…")', () => {
    for (const hostile of [
      'https://x.test/a).jpg',
      'https://x.test/a".jpg',
      "https://x.test/a'.jpg",
      'https://x.test/a b.jpg',
      'https://x.test/a;color:red',
      'https://x.test/<svg>',
      'https://x.test/a\\b.jpg',
      'https://x.test/a\nb.jpg',
      'https://x.test/a\u0000b.jpg',
    ]) {
      expect(safeEntityPicture(hostile, HA)).toBeNull();
    }
  });

  it('rejects non-http schemes and relative paths', () => {
    expect(safeEntityPicture('javascript:alert(1)', HA)).toBeNull();
    expect(safeEntityPicture('data:image/png;base64,AAAA', HA)).toBeNull();
    expect(safeEntityPicture('images/art.jpg', HA)).toBeNull();
  });

  it('rejects a root-relative path with no connection URL to resolve it', () => {
    expect(safeEntityPicture('/local/x.jpg', '')).toBeNull();
  });

  it('rejects non-strings and blanks', () => {
    expect(safeEntityPicture(undefined, HA)).toBeNull();
    expect(safeEntityPicture(null, HA)).toBeNull();
    expect(safeEntityPicture(42, HA)).toBeNull();
    expect(safeEntityPicture('   ', HA)).toBeNull();
  });
});

describe('pictureBackground', () => {
  it('quotes the URL and covers the element', () => {
    expect(pictureBackground('https://x.test/a.jpg')).toEqual({
      backgroundImage: 'url("https://x.test/a.jpg")',
      backgroundPosition: 'center',
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
    });
  });

  it('takes a position and size for portraits, which fit the card height', () => {
    expect(pictureBackground('https://x.test/a.jpg', {
      position: 'right center', size: 'auto 100%',
    })).toMatchObject({ backgroundPosition: 'right center', backgroundSize: 'auto 100%' });
  });
});
