// Synchronized LRC Lyrics Client & Parser for Cocoa Notch
// Multi-strategy lyrics engine powered by LRCLIB (synced LRC) and open lyric providers.

import { Bridge } from "./bridge";

export interface LrcLine {
  timeSecs: number;
  text: string;
}

export interface LyricsData {
  id?: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string;
  plainLyrics?: string;
  lines: LrcLine[];
  isInstrumental: boolean;
}

const lyricsCache = new Map<string, LyricsData | null>();
const pendingRequests = new Map<string, Promise<LyricsData | null>>();

export const CREDIT_OR_NOISE_LINE =
  /^(?:作\s*词|作\s*曲|编\s*曲|制\s*作|监\s*制|混\s*音|母\s*带|吉\s*他|贝\s*斯|鼓|键\s*盘|和\s*声|录\s*音|credits?|written\s+by|composed\s+by|produced\s+by|lyrics\s+by|arranged\s+by|published\s+by|mixed\s+by|mastered\s+by|recorded\s+at|engineer|label|copyright|all\s+rights\s+reserved)[\s:：]/i;

export const PLACEHOLDER_OR_STUB_LINE =
  /^(?:lyrics?\s+(?:not\s+available|not\s+found|pending|to\s+be\s+added)|add\s+lyrics|instrumental|pure\s+music|no\s+lyrics?\s+available|enjoy\s+the\s+music)\.?$/i;

/**
 * Validates whether an LRC string contains at least 3 genuine non-credit lyric lines.
 */
export function isValidLrc(lrcText: string): boolean {
  if (!lrcText || typeof lrcText !== "string") return false;
  const lines = parseLrc(lrcText);
  return lines.length >= 3;
}

/**
 * Parses standard LRC format strings ([mm:ss.xx] Lyrics text) into sorted LrcLine items.
 */
export function parseLrc(lrcText: string): LrcLine[] {
  if (!lrcText || typeof lrcText !== "string") return [];

  const lines: LrcLine[] = [];
  const rawLines = lrcText.split(/\r?\n/);

  // Regex to match one or more timestamps: [01:23.45], [01:23], or with offset suffix like [00:00.00-1]
  const tagRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:[-+]\d+)?\]/g;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const timestamps: number[] = [];
    let match: RegExpExecArray | null;

    tagRegex.lastIndex = 0;
    while ((match = tagRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      let millis = 0;
      if (match[3]) {
        const msStr = match[3].padEnd(3, "0").slice(0, 3);
        millis = parseInt(msStr, 10);
      }
      timestamps.push(minutes * 60 + seconds + millis / 1000);
    }

    if (timestamps.length > 0) {
      const text = trimmed.replace(tagRegex, "").trim();
      // Filter out pure credit / metadata lines and placeholder stubs
      if (text && !CREDIT_OR_NOISE_LINE.test(text) && !PLACEHOLDER_OR_STUB_LINE.test(text)) {
        for (const timeSecs of timestamps) {
          lines.push({ timeSecs, text });
        }
      }
    }
  }

  return lines.sort((a, b) => a.timeSecs - b.timeSecs);
}

/**
 * Synthesizes evenly distributed timestamps for plain lyrics when synced LRC is unavailable.
 */
export function synthesizeLinesFromPlain(plainLyrics: string, durationSecs?: number): LrcLine[] {
  if (!plainLyrics || typeof plainLyrics !== "string") return [];
  const rawLines = plainLyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l.startsWith("[") && l.endsWith("]")) return false;
      if (CREDIT_OR_NOISE_LINE.test(l) || PLACEHOLDER_OR_STUB_LINE.test(l)) return false;
      return true;
    });
  if (rawLines.length === 0) return [];

  const totalSecs = durationSecs && durationSecs > 10 ? durationSecs : 210;
  const introSecs = Math.min(8, totalSecs * 0.05);
  const outroSecs = Math.min(10, totalSecs * 0.05);
  const usableSecs = Math.max(10, totalSecs - introSecs - outroSecs);

  return rawLines.map((text, i) => {
    const timeSecs = introSecs + (i / rawLines.length) * usableSecs;
    return { timeSecs: Math.round(timeSecs * 10) / 10, text };
  });
}

/**
 * Finds the index of the currently active lyric line for the given playback time.
 * Returns -1 if playback is before the first timestamp.
 */
export function getActiveLyricIndex(lines: LrcLine[], currentTimeSecs: number): number {
  if (!lines || lines.length === 0) return -1;

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeSecs <= currentTimeSecs) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

export function cleanTitle(title: string): string {
  if (!title) return "";
  const cleaned = title
    .replace(/\s*[|/]\s*.*$/i, "")
    // Strip (From "Movie"), (From 'Movie'), (From Movie), [From ...], etc.
    .replace(/\s*[\(\[](?:from\s+["'“‘]?[^)\"\]]+["'”’]?|original\s+motion\s+picture\s+soundtrack|soundtrack\s+version|ost\s+version|ost)[^)\]]*[\)\]]/gi, "")
    // Strip common audio/video/edition/featured artist modifiers in parentheses
    .replace(/\s*\([^)]*(?:slowed|sped|remix|reverb|edit|version|feat|ft\.|prod|with|official|audio|video|tribute|cover|instrumental|deluxe|remaster(?:ed)?|mono|stereo|anniversary|radio|extended|acoustic|live|session|mix|reprise|theme)[^)]*\)/gi, "")
    .replace(/\s*\[[^\]]*\]/gi, "")
    // Strip trailing "- From ...", "- Remix", "- Live", "- 2013 Remaster", "- Explicit", etc.
    .replace(/\s*-\s*[^-(]*(?:from\s+["']?[^"'-]+|soundtrack|slowed|sped|remix|reverb|edit|version|instrumental|deluxe|remaster(?:ed)?|\d{4}\s+remaster|bonus|radio|live|acoustic|reprise|session|explicit|clean).*$/gi, "")
    .replace(/^["'“‘](.*)["'”’]$/, "$1")
    .trim();
  return cleaned || title.trim();
}

export function getTitleVariants(title: string): string[] {
  if (!title) return [];
  const raw = title.trim();
  const variants = [raw];

  const cleaned = cleanTitle(raw);
  if (cleaned && !variants.includes(cleaned)) {
    variants.push(cleaned);
  }

  // Base title: strip after first ' - ' or '(' or '['
  const base = raw.split(/\s*[-–—]\s*/)[0].split(/\s*[([|/]/)[0].trim();
  if (base && !variants.includes(base) && base.length >= 2) {
    variants.push(base);
  }

  return variants;
}

export function getArtistVariants(artist: string): string[] {
  if (!artist) return [];
  const raw = artist.split("·")[0].trim();
  const variants = [raw];

  // Disambiguate all collaborating artists
  const tokens = raw
    .split(/[,;&\/]|\s+(?:feat\.|ft\.|with|&|x)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const t of tokens) {
    if (!variants.includes(t)) {
      variants.push(t);
    }
  }

  return variants;
}

export function decodeHtmlEntities(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&hellip;|&#8230;/g, "…")
    .replace(/\u00a0/g, " ");
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 3000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function scoreGeniusHit(hit: any, targetTitle: string, targetArtist: string): number {
  if (hit.type !== "song" || !hit.result?.path) return -100;
  const t = (hit.result.title || "").toLowerCase();
  const a = (hit.result.primary_artist?.name || "").toLowerCase();
  const targetT = targetTitle.toLowerCase();
  const targetA = targetArtist.toLowerCase();

  let score = 0;
  if (t === targetT) score += 60;
  else if (t.includes(targetT)) score += 35;

  if (targetA) {
    if (a.includes(targetA) || targetA.includes(a)) score += 40;
    else if (t.includes(targetA)) score += 20;
  }

  if (t.includes("translation") && !targetT.includes("translation")) score -= 25;
  if (t.includes("instrumental") && !targetT.includes("instrumental")) score -= 40;
  if (t.includes("annotated")) score -= 30;
  if (t.includes("tracklist")) score -= 50;
  if (t.includes("credits")) score -= 30;
  if (t.includes("romanized")) score += 5;

  return score;
}

/**
 * Searches and extracts accurate song lyrics from Genius as an open fallback.
 */
export async function fetchGeniusLyricsWeb(
  title: string,
  artist?: string
): Promise<{ trackName: string; artistName: string; plainLyrics: string } | null> {
  const cleanT = cleanTitle(title || "");
  const cleanA = (artist || "").split("·")[0].split(/[,;&\/]/)[0].trim();
  const q = `${cleanA ? `${cleanA} ` : ""}${cleanT}`.trim();
  if (!q) return null;

  try {
    const searchUrl = `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(q)}`;
    const searchRes = await fetchWithTimeout(
      searchUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      },
      3800
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json().catch(() => null);
    const sections = searchData?.response?.sections || [];
    const songSection = sections.find((s: any) => s.type === "song" || s.type === "top_hit");
    const rawHits: any[] = songSection?.hits || [];
    const songHits = rawHits.filter((h: any) => h.type === "song" && h.result?.path);
    if (songHits.length === 0) return null;

    const scoredHits = songHits
      .map((h: any) => ({ hit: h, score: scoreGeniusHit(h, cleanT, cleanA) }))
      .sort((a: any, b: any) => b.score - a.score);
    const hit = scoredHits[0]?.hit || songHits[0];

    const songPath = hit?.result?.path;
    if (!songPath) return null;

    const pageRes = await fetchWithTimeout(
      `https://genius.com${songPath}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      },
      4200
    );
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const parts = html.split(/data-lyrics-container="true"[^>]*>/);
    if (parts.length <= 1) return null;

    let combined = "";
    for (let i = 1; i < parts.length; i++) {
      let block = parts[i];
      const cutPos = block.search(
        /<div class="Lyrics__Footer|<div class="RightSidebar|<section|<div class="SongHeader/
      );
      if (cutPos > 0) block = block.slice(0, cutPos);
      combined +=
        "\n" +
        decodeHtmlEntities(
          block
            .replace(/<br\s*[\/]?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
        ).trim();
    }

    const lines = combined
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !(l.startsWith("[") && l.endsWith("]")) &&
          !l.includes("Contributors") &&
          !l.includes("Translations") &&
          !l.endsWith("Lyrics") &&
          !CREDIT_OR_NOISE_LINE.test(l) &&
          !PLACEHOLDER_OR_STUB_LINE.test(l)
      );

    if (lines.length < 3) return null;

    return {
      trackName: hit?.result?.title || cleanT,
      artistName: hit?.result?.primary_artist?.name || cleanA,
      plainLyrics: lines.join("\n"),
    };
  } catch {
    return null;
  }
}

/**
 * Fetches synced lyrics with multi-strategy matching and plain lyrics fallback.
 */
export function pickBestLrclibMatch(list: any[], durationSecs?: number): any {
  if (!Array.isArray(list) || list.length === 0) return null;
  const synced = list.filter((it: any) => it.syncedLyrics);
  if (synced.length > 0) {
    if (durationSecs && durationSecs > 0) {
      synced.sort(
        (a: any, b: any) =>
          Math.abs((a.duration || 0) - durationSecs) - Math.abs((b.duration || 0) - durationSecs)
      );
    }
    return synced[0];
  }
  const plain = list.filter((it: any) => it.plainLyrics);
  if (plain.length > 0) {
    if (durationSecs && durationSecs > 0) {
      plain.sort(
        (a: any, b: any) =>
          Math.abs((a.duration || 0) - durationSecs) - Math.abs((b.duration || 0) - durationSecs)
      );
    }
    return plain[0];
  }
  return null;
}

export async function fetchLyrics(
  title: string,
  artist: string,
  durationSecs?: number,
): Promise<LyricsData | null> {
  const cleanT = cleanTitle(title || "");
  const cleanA = (artist || "").trim();

  if (!cleanT) return null;

  const cacheKey = `${cleanA.toLowerCase()}:::${cleanT.toLowerCase()}`;
  if (lyricsCache.has(cacheKey)) {
    const cached = lyricsCache.get(cacheKey);
    if (cached) return cached;
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      // Primary: Native Rust fetch_lyrics command (bypasses WebView2 CSP, CORS & browser sandboxing)
      if (Bridge.fetchLyrics) {
        try {
          const nativeData = await Bridge.fetchLyrics(cleanT, cleanA, durationSecs);
          if (nativeData && (nativeData.syncedLyrics || nativeData.plainLyrics)) {
            let lines = nativeData.syncedLyrics ? parseLrc(nativeData.syncedLyrics) : [];
            if (lines.length === 0 && nativeData.plainLyrics) {
              lines = synthesizeLinesFromPlain(nativeData.plainLyrics, nativeData.duration || durationSecs);
            }
            if (lines.length > 0 || nativeData.plainLyrics) {
              const result: LyricsData = {
                trackName: nativeData.trackName || cleanT,
                artistName: nativeData.artistName || cleanA,
                albumName: nativeData.albumName,
                duration: nativeData.duration,
                syncedLyrics: nativeData.syncedLyrics,
                plainLyrics: nativeData.plainLyrics,
                lines,
                isInstrumental: nativeData.instrumental === true || (lines.length === 0 && !nativeData.plainLyrics),
              };
              lyricsCache.set(cacheKey, result);
              return result;
            }
          }
        } catch (err) {
          console.warn("[lyrics] Native fetchLyrics failed, falling back to web fetch:", err);
        }
      }

      const titles = getTitleVariants(cleanT);
      const artists = getArtistVariants(cleanA);
      let data: any = null;
      // Strategy 1: Exact GET without strict duration (avoids 404 on slowed/sped tracks)
      for (const t of titles) {
        if (data) break;
        for (const art of artists) {
          if (data) break;
          try {
            const params = new URLSearchParams({ track_name: t, artist_name: art });
            const res = await fetchWithTimeout(`https://lrclib.net/api/get?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            }, 3000);
            if (res.status >= 500) continue;
            if (res.ok) {
              const d = await res.json().catch(() => null);
              if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
            }
          } catch {}
        }
      }

      // Strategy 2: Exact GET with duration if provided
      if (!data && durationSecs && durationSecs > 0) {
        for (const t of titles) {
          if (data) break;
          for (const art of artists) {
            if (data) break;
            try {
              const params = new URLSearchParams({
                track_name: t,
                artist_name: art,
                duration: Math.round(durationSecs).toString(),
              });
              const res = await fetchWithTimeout(`https://lrclib.net/api/get?${params.toString()}`, {
                headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
              }, 3000);
              if (res.status >= 500) continue;
              if (res.ok) {
                const d = await res.json().catch(() => null);
                if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
              }
            } catch {}
          }
        }
      }

      // Strategy 3: Structured search on LRCLIB
      if (!data) {
        for (const t of titles) {
          if (data) break;
          for (const art of artists) {
            if (data) break;
            try {
              const params = new URLSearchParams({ track_name: t, artist_name: art });
              const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
                headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
              }, 3000);
              if (res.status >= 500) continue;
              if (res.ok) {
                const list = await res.json().catch(() => null);
                if (Array.isArray(list) && list.length > 0) {
                  data = pickBestLrclibMatch(list, durationSecs);
                }
              }
            } catch {}
          }
        }
      }

      // Strategy 4: Full query on LRCLIB
      if (!data) {
        for (const t of titles) {
          if (data) break;
          try {
            const q = `${artists[0] || ""} ${t}`.trim();
            const params = new URLSearchParams({ q });
            const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            }, 3000);
            if (res.status >= 500) continue; else if (res.ok) {
              const list = await res.json().catch(() => null);
              if (Array.isArray(list) && list.length > 0) {
                data = pickBestLrclibMatch(list, durationSecs);
              }
            }
          } catch {}
        }
      }

      // Strategy 5: Clean title-only query on LRCLIB
      if (!data) {
        for (const t of titles) {
          if (data) break;
          try {
            const params = new URLSearchParams({ q: t });
            const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            }, 3000);
            if (res.ok) {
              const list = await res.json().catch(() => null);
              if (Array.isArray(list) && list.length > 0) {
                data = pickBestLrclibMatch(list, durationSecs);
              }
            }
          } catch {}
        }
      }

      // Strategy 6: NetEase Cloud Music search & synced LRC
      if (!data) {
        for (const t of titles) {
          if (data) break;
          for (const art of artists) {
            if (data) break;
            try {
              const q = `${art ? `${art} ` : ""}${t}`.trim();
              const searchRes = await fetchWithTimeout(
                `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=1`,
                {
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  },
                },
                3500
              );
              if (searchRes.ok) {
                const searchData = await searchRes.json().catch(() => null);
                const song = searchData?.result?.songs?.[0];
                if (song?.id) {
                  const lrcRes = await fetchWithTimeout(
                    `https://music.163.com/api/song/lyric?os=pc&id=${song.id}&lv=-1&kv=-1&tv=-1`,
                    {
                      headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                      },
                    },
                    3500
                  );
                  if (lrcRes.ok) {
                    const lrcData = await lrcRes.json().catch(() => null);
                    const syncedLyrics = lrcData?.lrc?.lyric;
                    if (syncedLyrics && typeof syncedLyrics === "string" && isValidLrc(syncedLyrics)) {
                      data = {
                        id: song.id,
                        trackName: song.name || t,
                        artistName: song.artists?.[0]?.name || art || cleanA,
                        syncedLyrics,
                      };
                      break;
                    }
                  }
                }
              }
            } catch {}
          }
        }
      }

      // Strategy 6.5: Genius search and open lyrics extraction (high-accuracy global coverage)
      if (!data) {
        for (const t of titles) {
          if (data) break;
          for (const art of artists) {
            if (data) break;
            try {
              const geniusData = await fetchGeniusLyricsWeb(t, art || cleanA);
              if (geniusData && geniusData.plainLyrics) {
                data = geniusData;
                break;
              }
            } catch {}
          }
        }
      }

      // Strategy 7: Fallback to Lyrics.ovh for plain text lyrics
      if (!data) {
        for (const t of titles) {
          if (data) break;
          for (const art of artists) {
            if (data || !art) continue;
            try {
              const res = await fetchWithTimeout(
                `https://api.lyrics.ovh/v1/${encodeURIComponent(art)}/${encodeURIComponent(t)}`,
                undefined,
                3500
              );
              if (res.ok) {
                const d = await res.json().catch(() => null);
                if (d && d.lyrics && typeof d.lyrics === "string" && d.lyrics.trim()) {
                  const cleanedLines = d.lyrics
                    .split(/\r?\n/)
                    .map((l: string) => l.trim())
                    .filter((l: string) => l && !CREDIT_OR_NOISE_LINE.test(l) && !PLACEHOLDER_OR_STUB_LINE.test(l));
                  if (cleanedLines.length >= 3) {
                    data = {
                      trackName: t,
                      artistName: art,
                      plainLyrics: cleanedLines.join("\n"),
                    };
                    break;
                  }
                }
              }
            } catch {}
          }
        }
      }

      if (!data) {
        const emptyResult: LyricsData = {
          trackName: cleanT,
          artistName: cleanA,
          lines: [],
          isInstrumental: true,
        };
        lyricsCache.set(cacheKey, emptyResult);
        setTimeout(() => {
          if (lyricsCache.get(cacheKey) === emptyResult) {
            lyricsCache.delete(cacheKey);
          }
        }, 60000);
        return emptyResult;
      }

      const syncedLyrics: string | undefined = data.syncedLyrics || undefined;
      const plainLyrics: string | undefined = data.plainLyrics || undefined;
      const isInstrumental = Boolean(data.instrumental);
      let lines = syncedLyrics ? parseLrc(syncedLyrics) : [];
      if (lines.length === 0 && plainLyrics) {
        lines = synthesizeLinesFromPlain(plainLyrics, data.duration || durationSecs);
      }

      const result: LyricsData = {
        id: data.id,
        trackName: data.trackName || cleanT,
        artistName: data.artistName || cleanA,
        albumName: data.albumName,
        duration: data.duration,
        syncedLyrics,
        plainLyrics,
        lines,
        isInstrumental,
      };

      lyricsCache.set(cacheKey, result);
      return result;
    } catch {
      return null;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}
