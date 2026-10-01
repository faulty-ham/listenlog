/**
 * ListenLog -> Plex Rating Proxy Worker
 * Deploy as a separate Worker: "listenlog-plex-proxy"
 *
 * Environment variables (Settings -> Variables and Secrets):
 *   PLEX_URL       (secret) — e.g. https://your-plex.direct:32400 or http://192.168.1.50:32400
 *   PLEX_TOKEN     (secret) — your Plex token
 *   ALLOWED_ORIGIN (text)   — https://faulty-ham.github.io
 *
 * Matching, in priority order:
 *   1. Exact artist + title (space-insensitive — "40 oz." and "40oz." count
 *      as the same title), and if BOTH sides have a year, it agrees too.
 *      Several same-titled albums by an artist (four different Peter
 *      Gabriel albums are all just called "Peter Gabriel") are
 *      disambiguated by year when available.
 *   2. Same title, year known on both sides and DISAGREES -> almost
 *      certainly a different release wearing the same title (an EP vs. the
 *      LP) — never auto-accepted, not even for the presence-only check.
 *   3. Same artist, edition/reissue title (one title is a word-boundary
 *      prefix of the other, e.g. "Grace" vs "Grace (Legacy Edition)").
 *   4. Exact title, different artist credit (e.g. "Rufus" vs "Rufus feat.
 *      Chaka Khan").
 *   Tiers 3-4 are "partial" — confirmation needed for a rating push;
 *   auto-accepted for the low-stakes presence-only check. Tier 2
 *   (year-mismatch) is never auto-accepted anywhere, rating push or
 *   presence check alike — it's offered as a confirmable partial match
 *   instead, same as tiers 3-4 are for a rating push.
 *
 * When NOTHING matches at all, the response includes up to 3 closest
 * candidates (by edit distance) for the person to pick from manually —
 * for both the rating flow and the presence-only check.
 *
 * Usage from the app:
 *   GET /?artist=X&album=Y&rating=N&year=YYYY
 *     -> exact match:    { matched: true, plexRating: 8 }
 *     -> partial match:  { matched: false, partial: { key, artist, album } }
 *     -> no match at all: { matched: false, suggestions: [{key,artist,album}, ...] }
 *
 *   GET /?confirmKey=RATINGKEY&rating=N
 *     -> rates that specific album directly, used after the person confirms
 *        a partial match or picks a suggestion. { matched: true, plexRating: 8 }
 *   GET /?confirmKey=RATINGKEY   (rating omitted)
 *     -> presence-only confirmation — nothing is written to Plex, just
 *        reports the match. { matched: true }
 *
 *   GET /?artist=X&album=Y&year=YYYY&checkOnly=1
 *     -> pure library-presence lookup, no rating ever touched:
 *        { inLibrary: true, matchType: 'exact' | 'partial' }
 *        { inLibrary: false, partial: { key, artist, album } }   (year-mismatch candidate)
 *        { inLibrary: false, suggestions: [{key,artist,album}, ...] }  (nothing matched)
 *        { inLibrary: false }   (no music library found)
 */

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Also collapses all whitespace, so "40 oz to freedom" and "40oz to
// freedom" compare equal — catches inconsistent spacing around abbreviated
// units/numbers that plain normalize() alone treats as genuinely different.
function tightNormalize(s) {
  return normalize(s).replace(/\s+/g, '');
}

function titlesMatch(a, b) {
  return normalize(a) === normalize(b) || tightNormalize(a) === tightNormalize(b);
}

// Word-boundary prefix check: "grace legacy edition" starts with "grace ",
// so it counts; "graceland" does NOT start with "grace " (no space), so it
// correctly avoids matching on a partial word.
function isTitlePrefixOf(shorter, longer) {
  return longer.startsWith(shorter + ' ');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// Closest-title candidates when nothing matched at all — prefers the same
// artist if that artist has any albums in Plex, otherwise searches the
// whole library (helps when the artist credit itself is also off).
function findClosestSuggestions(plexAlbums, artist, album, limit = 3) {
  const normArtist = normalize(artist), normAlbum = normalize(album);
  const sameArtist = plexAlbums.filter(p => normalize(p.artist) === normArtist);
  const pool = sameArtist.length ? sameArtist : plexAlbums;
  return pool
    .map(p => ({ p, dist: levenshtein(normAlbum, normalize(p.title)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map(x => x.p);
}

function findMatch(plexAlbums, artist, album, year) {
  const normArtist = normalize(artist);
  const y = year ? parseInt(year, 10) : null;

  const titleCandidates = plexAlbums.filter(
    p => normalize(p.artist) === normArtist && titlesMatch(p.title, album)
  );

  if (titleCandidates.length) {
    if (y) {
      const yearMatches = titleCandidates.filter(p => p.year && parseInt(p.year, 10) === y);
      if (yearMatches.length) return { tier: 'exact', reason: 'year-confirmed', album: yearMatches[0] };
      return { tier: 'partial', reason: 'year-mismatch', album: titleCandidates[0] };
    }
    if (titleCandidates.length === 1) return { tier: 'exact', reason: 'no-year-data', album: titleCandidates[0] };
    return { tier: 'partial', reason: 'year-mismatch', album: titleCandidates[0] };
  }

  const normAlbum = normalize(album);
  const sameArtistEdition = plexAlbums.find(p => {
    if (normalize(p.artist) !== normArtist) return false;
    const t = normalize(p.title);
    return t !== normAlbum && (isTitlePrefixOf(normAlbum, t) || isTitlePrefixOf(t, normAlbum));
  });
  if (sameArtistEdition) return { tier: 'partial', reason: 'edition-variant', album: sameArtistEdition };

  const titleOnly = plexAlbums.find(p => normalize(p.title) === normAlbum);
  if (titleOnly) return { tier: 'partial', reason: 'title-only', album: titleOnly };

  return null;
}

// For the presence-only check: exact matches always count, and partial
// matches count UNLESS the reason is a year mismatch.
function countsAsPresent(match) {
  if (!match) return false;
  if (match.tier === 'exact') return true;
  return match.reason !== 'year-mismatch';
}

async function getMusicSectionKey(plexUrl, token) {
  const res = await fetch(`${plexUrl}/library/sections`, {
    headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
  });
  const data = await res.json();
  const dirs = data?.MediaContainer?.Directory || [];
  const music = dirs.find(d => d.type === 'artist');
  return music ? music.key : null;
}

async function fetchAllPlexAlbums(plexUrl, token, sectionKey) {
  const res = await fetch(`${plexUrl}/library/sections/${sectionKey}/all?type=9`, {
    headers: { 'X-Plex-Token': token, 'Accept': 'application/json' }
  });
  const data = await res.json();
  const items = data?.MediaContainer?.Metadata || [];
  return items.map(i => ({
    ratingKey: i.ratingKey,
    title: i.title || '',
    artist: i.parentTitle || '',
    year: i.year || null,
  }));
}

async function rateAlbum(plexUrl, token, ratingKey, rating) {
  const plexRating = Math.min(10, Math.max(0, Math.round(rating * 2)));
  const res = await fetch(
    `${plexUrl}/:/rate?key=${ratingKey}&identifier=com.plexapp.plugins.library&rating=${plexRating}`,
    { method: 'PUT', headers: { 'X-Plex-Token': token } }
  );
  return { ok: res.ok, plexRating };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://faulty-ham.github.io';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin === allowed ? origin : '',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const artist       = url.searchParams.get('artist') || '';
    const album        = url.searchParams.get('album')  || '';
    const year         = url.searchParams.get('year')   || '';
    const ratingParam  = url.searchParams.get('rating');
    const rating       = ratingParam !== null ? parseFloat(ratingParam) : NaN;
    const confirmKey   = url.searchParams.get('confirmKey') || '';
    const checkOnly    = url.searchParams.get('checkOnly') === '1';

    if (checkOnly) {
      if (!artist || !album) {
        return new Response(JSON.stringify({ error: 'Missing required parameters' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } else if (!confirmKey && (isNaN(rating) || !artist || !album)) {
      // confirmKey mode is self-sufficient (the key alone identifies the
      // album) — a rating is only required to actually push one, so a
      // presence-only confirm (no rating param at all) is valid too. Every
      // other mode still needs a real rating plus artist/album to search.
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      if (checkOnly) {
        const sectionKey = await getMusicSectionKey(env.PLEX_URL, env.PLEX_TOKEN);
        if (!sectionKey) {
          return new Response(JSON.stringify({ inLibrary: false, error: 'No music library found' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const plexAlbums = await fetchAllPlexAlbums(env.PLEX_URL, env.PLEX_TOKEN, sectionKey);
        const match = findMatch(plexAlbums, artist, album, year);

        if (countsAsPresent(match)) {
          return new Response(JSON.stringify({ inLibrary: true, matchType: match.tier }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Doesn't auto-count as present — today that's only the
        // year-mismatch reason — but it's still a real candidate, so offer
        // it the same way the rating endpoint does rather than just giving
        // up. Confirming calls back with confirmKey and no rating.
        if (match && match.tier === 'partial') {
          return new Response(JSON.stringify({
            inLibrary: false,
            partial: { key: match.album.ratingKey, artist: match.album.artist, album: match.album.title },
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Nothing matched at all — offer the closest candidates here too,
        // same as the rating flow does.
        const suggestions = findClosestSuggestions(plexAlbums, artist, album)
          .map(p => ({ key: p.ratingKey, artist: p.artist, album: p.title }));
        return new Response(JSON.stringify({ inLibrary: false, suggestions }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Confirm-by-key mode — person already approved a partial match (or
      // picked one of the closest-match suggestions), so skip searching
      // entirely. With a rating, rate it directly; without one (confirming
      // a presence-only candidate), there's nothing to push — just report
      // the match.
      if (confirmKey) {
        if (isNaN(rating)) {
          return new Response(JSON.stringify({ matched: true }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const { ok, plexRating } = await rateAlbum(env.PLEX_URL, env.PLEX_TOKEN, confirmKey, rating);
        return new Response(JSON.stringify(ok ? { matched: true, plexRating } : { matched: false, error: 'Rate call failed' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const sectionKey = await getMusicSectionKey(env.PLEX_URL, env.PLEX_TOKEN);
      if (!sectionKey) {
        return new Response(JSON.stringify({ matched: false, error: 'No music library found' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const plexAlbums = await fetchAllPlexAlbums(env.PLEX_URL, env.PLEX_TOKEN, sectionKey);
      const match = findMatch(plexAlbums, artist, album, year);

      if (match && match.tier === 'exact') {
        const { ok, plexRating } = await rateAlbum(env.PLEX_URL, env.PLEX_TOKEN, match.album.ratingKey, rating);
        return new Response(JSON.stringify(ok ? { matched: true, plexRating } : { matched: true, error: 'Rate call failed' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (match && match.tier === 'partial') {
        return new Response(JSON.stringify({
          matched: false,
          partial: { key: match.album.ratingKey, artist: match.album.artist, album: match.album.title },
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Nothing matched at all — offer the closest candidates to pick from
      // manually rather than just giving up.
      const suggestions = findClosestSuggestions(plexAlbums, artist, album)
        .map(p => ({ key: p.ratingKey, artist: p.artist, album: p.title }));
      return new Response(JSON.stringify({ matched: false, suggestions }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (e) {
      return new Response(JSON.stringify({ matched: false, error: e.message }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
};
