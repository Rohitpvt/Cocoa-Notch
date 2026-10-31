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

/**
 * Parses standard LRC format strings ([mm:ss.xx] Lyrics text) into sorted LrcLine items.
 */
export function parseLrc(lrcText: string): LrcLine[] {
  if (!lrcText || typeof lrcText !== "string") return [];

  const lines: LrcLine[] = [];
  const rawLines = lrcText.split(/\r?\n/);

  // Regex to match one or more timestamps: [01:23.45] or [01:23]
  const tagRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

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
      for (const timeSecs of timestamps) {
        lines.push({ timeSecs, text });
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
    .filter(Boolean);
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
    .replace(/\s*[|]\s*.*$/i, "")
    .replace(/\s*\([^)]*(?:slowed|sped|remix|reverb|edit|version|feat|ft\.|prod|official|audio|video|tribute|cover|instrumental|deluxe|remastered|mono|stereo)[^)]*\)/gi, "")
    .replace(/\s*\[[^\]]*\]/gi, "")
    .replace(/\s*-\s*[^-(]*(?:slowed|sped|remix|reverb|edit|version|instrumental|deluxe|remastered|bonus).*$/gi, "")
    .trim();
  return cleaned || title.trim();
}

export function getArtistVariants(artist: string): string[] {
  if (!artist) return [];
  const raw = artist.split("·")[0].trim();
  const variants = [raw];
  const primary = raw.split(/[,;&\/]|\s+(?:feat\.|ft\.|with)\s+/i)[0].trim();
  if (primary && primary !== raw) variants.push(primary);
  return variants;
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

/**
 * Fetches synced lyrics with multi-strategy matching and plain lyrics fallback.
 */
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
        } catch (err) {
          console.warn("[lyrics] Native fetchLyrics failed, falling back to web fetch:", err);
        }
      }

      const artists = getArtistVariants(cleanA);
      let data: any = null;
      let lrclibDown = false;

      // Strategy 1: Exact GET without strict duration (avoids 404 on slowed/sped tracks)
      for (const art of artists) {
        if (data || lrclibDown) break;
        try {
          const params = new URLSearchParams({ track_name: cleanT, artist_name: art });
          const res = await fetchWithTimeout(`https://lrclib.net/api/get?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          }, 3000);
          if (res.status >= 500) {
            lrclibDown = true;
            break;
          }
          if (res.ok) {
            const d = await res.json().catch(() => null);
            if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
          }
        } catch {
          lrclibDown = true;
          break;
        }
      }

      // Strategy 2: Exact GET with duration if provided
      if (!data && !lrclibDown && durationSecs && durationSecs > 0) {
        for (const art of artists) {
          if (data || lrclibDown) break;
          try {
            const params = new URLSearchParams({
              track_name: cleanT,
              artist_name: art,
              duration: Math.round(durationSecs).toString(),
            });
            const res = await fetchWithTimeout(`https://lrclib.net/api/get?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            }, 3000);
            if (res.status >= 500) {
              lrclibDown = true;
              break;
            }
            if (res.ok) {
              const d = await res.json().catch(() => null);
              if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
            }
          } catch {
            lrclibDown = true;
            break;
          }
        }
      }

      // Strategy 3: Structured search on LRCLIB
      if (!data && !lrclibDown) {
        for (const art of artists) {
          if (data || lrclibDown) break;
          try {
            const params = new URLSearchParams({ track_name: cleanT, artist_name: art });
            const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            }, 3000);
            if (res.status >= 500) {
              lrclibDown = true;
              break;
            }
            if (res.ok) {
              const list = await res.json().catch(() => null);
              if (Array.isArray(list) && list.length > 0) {
                data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
              }
            }
          } catch {
            lrclibDown = true;
            break;
          }
        }
      }

      // Strategy 4: Full query on LRCLIB
      if (!data && !lrclibDown) {
        try {
          const q = `${artists[0] || ""} ${cleanT}`.trim();
          const params = new URLSearchParams({ q });
          const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          }, 3000);
          if (res.status >= 500) {
            lrclibDown = true;
          } else if (res.ok) {
            const list = await res.json().catch(() => null);
            if (Array.isArray(list) && list.length > 0) {
              data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
            }
          }
        } catch {
          lrclibDown = true;
        }
      }

      // Strategy 5: Clean title-only query on LRCLIB
      if (!data && !lrclibDown) {
        try {
          const params = new URLSearchParams({ q: cleanT });
          const res = await fetchWithTimeout(`https://lrclib.net/api/search?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          }, 3000);
          if (res.ok) {
            const list = await res.json().catch(() => null);
            if (Array.isArray(list) && list.length > 0) {
              data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
            }
          }
        } catch {}
      }

      // Strategy 6: NetEase Cloud Music search & synced LRC
      if (!data) {
        for (const art of artists) {
          if (data) break;
          try {
            const q = `${art ? `${art} ` : ""}${cleanT}`.trim();
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
                  if (syncedLyrics && typeof syncedLyrics === "string" && syncedLyrics.includes("[")) {
                    data = {
                      id: song.id,
                      trackName: song.name || cleanT,
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

      // Strategy 7: Fallback to Lyrics.ovh for plain text lyrics
      if (!data) {
        for (const art of artists) {
          if (data || !art) continue;
          try {
            const res = await fetchWithTimeout(
              `https://api.lyrics.ovh/v1/${encodeURIComponent(art)}/${encodeURIComponent(cleanT)}`,
              undefined,
              3500
            );
            if (res.ok) {
              const d = await res.json().catch(() => null);
              if (d && d.lyrics && typeof d.lyrics === "string" && d.lyrics.trim()) {
                data = {
                  trackName: cleanT,
                  artistName: art,
                  plainLyrics: d.lyrics.trim(),
                };
                break;
              }
            }
          } catch {}
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
