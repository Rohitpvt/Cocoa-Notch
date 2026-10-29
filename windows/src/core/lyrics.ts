// Synchronized LRC Lyrics Client & Parser for Cocoa Notch
// Powered by the open-source LRCLIB API (https://lrclib.net)

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
    // If line time is less than or equal to current position, it's active
    if (lines[i].timeSecs <= currentTimeSecs + 0.1) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*-\s*(Remastered|Deluxe|Live|Original|Edit|Single|Radio|Acoustic).*$/i, "")
    .replace(/\s*\(feat\..*?\)/i, "")
    .replace(/\s*\(with.*?\)/i, "")
    .replace(/\s*\[.*?\]/i, "")
    .trim();
}

/**
 * Fetches synced lyrics from LRCLIB with in-memory caching.
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
    return lyricsCache.get(cacheKey) || null;
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const params = new URLSearchParams({
        track_name: cleanT,
        artist_name: cleanA,
      });
      if (durationSecs && durationSecs > 0) {
        params.set("duration", Math.round(durationSecs).toString());
      }

      // Try exact get first
      const getUrl = `https://lrclib.net/api/get?${params.toString()}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      let resp = await fetch(getUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
      }).catch(() => null);

      clearTimeout(timeoutId);

      let data: any = null;
      if (resp && resp.ok) {
        data = await resp.json().catch(() => null);
      }

      // If not found, try search endpoint
      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        const searchParams = new URLSearchParams({
          q: `${cleanA} ${cleanT}`.trim(),
        });
        const searchUrl = `https://lrclib.net/api/search?${searchParams.toString()}`;
        const searchController = new AbortController();
        const searchTimeout = setTimeout(() => searchController.abort(), 6000);

        const searchResp = await fetch(searchUrl, {
          signal: searchController.signal,
          headers: { "User-Agent": "CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)" },
        }).catch(() => null);

        clearTimeout(searchTimeout);

        if (searchResp && searchResp.ok) {
          const list = await searchResp.json().catch(() => null);
          if (Array.isArray(list) && list.length > 0) {
            // Find item with syncedLyrics if possible
            data = list.find((it: any) => it.syncedLyrics) || list[0];
          }
        }
      }

      if (!data) {
        lyricsCache.set(cacheKey, null);
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
      lyricsCache.set(cacheKey, null);
      return null;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}
