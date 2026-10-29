// Synchronized LRC Lyrics Client & Parser for Cocoa Notch
// Multi-strategy lyrics engine powered by LRCLIB (synced LRC) and open lyric providers.

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
 * Finds the index of the currently active lyric line for the given playback time.
 * Returns -1 if playback is before the first timestamp.
 */
export function getActiveLyricIndex(lines: LrcLine[], currentTimeSecs: number): number {
  if (!lines || lines.length === 0) return -1;

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeSecs <= currentTimeSecs + 0.1) {
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
    let networkError = false;
    try {
      const artists = getArtistVariants(cleanA);
      let data: any = null;

      // Strategy 1: Exact GET without strict duration (avoids 404 on slowed/sped tracks)
      for (const art of artists) {
        if (data) break;
        try {
          const params = new URLSearchParams({ track_name: cleanT, artist_name: art });
          const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          });
          if (res.ok) {
            const d = await res.json().catch(() => null);
            if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
          }
        } catch {
          networkError = true;
        }
      }

      // Strategy 2: Exact GET with duration if provided
      if (!data && durationSecs && durationSecs > 0) {
        for (const art of artists) {
          if (data) break;
          try {
            const params = new URLSearchParams({
              track_name: cleanT,
              artist_name: art,
              duration: Math.round(durationSecs).toString(),
            });
            const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            });
            if (res.ok) {
              const d = await res.json().catch(() => null);
              if (d && (d.syncedLyrics || d.plainLyrics)) data = d;
            }
          } catch {
            networkError = true;
          }
        }
      }

      // Strategy 3: Structured search on LRCLIB
      if (!data) {
        for (const art of artists) {
          if (data) break;
          try {
            const params = new URLSearchParams({ track_name: cleanT, artist_name: art });
            const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
              headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
            });
            if (res.ok) {
              const list = await res.json().catch(() => null);
              if (Array.isArray(list) && list.length > 0) {
                data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
              }
            }
          } catch {
            networkError = true;
          }
        }
      }

      // Strategy 4: Full query on LRCLIB
      if (!data) {
        try {
          const q = `${artists[0] || ""} ${cleanT}`.trim();
          const params = new URLSearchParams({ q });
          const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          });
          if (res.ok) {
            const list = await res.json().catch(() => null);
            if (Array.isArray(list) && list.length > 0) {
              data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
            }
          }
        } catch {
          networkError = true;
        }
      }

      // Strategy 5: Clean title-only query on LRCLIB
      if (!data) {
        try {
          const params = new URLSearchParams({ q: cleanT });
          const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
            headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
          });
          if (res.ok) {
            const list = await res.json().catch(() => null);
            if (Array.isArray(list) && list.length > 0) {
              data = list.find((it: any) => it.syncedLyrics) || list.find((it: any) => it.plainLyrics);
            }
          }
        } catch {
          networkError = true;
        }
      }

      // Strategy 6: Fallback to Lyrics.ovh for plain text lyrics
      if (!data) {
        for (const art of artists) {
          if (data) break;
          try {
            const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(art)}/${encodeURIComponent(cleanT)}`);
            if (res.ok) {
              const d = await res.json().catch(() => null);
              if (d && d.lyrics) {
                data = {
                  trackName: cleanT,
                  artistName: art,
                  plainLyrics: d.lyrics,
                };
              }
            }
          } catch {}
        }
      }

      if (!data) {
        if (!networkError) {
          lyricsCache.set(cacheKey, null);
        }
        return null;
      }

      const syncedLyrics: string | undefined = data.syncedLyrics || undefined;
      const plainLyrics: string | undefined = data.plainLyrics || undefined;
      const isInstrumental = Boolean(data.instrumental);
      const lines = syncedLyrics ? parseLrc(syncedLyrics) : [];

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
