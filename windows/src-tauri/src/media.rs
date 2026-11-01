// Universal Media Playback & Controls Listener (Windows GSMTC)
// Powered by Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager
// Supports Spotify, YouTube Music, Apple Music, and any browser/media app.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use reqwest::Url;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlaybackState {
    pub is_playing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_art_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
}

pub struct MediaState {
    pub current: Mutex<Option<MusicPlaybackState>>,
}

impl MediaState {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

#[cfg(windows)]
mod win {
    use super::MusicPlaybackState;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    pub fn get_session_manager() -> Option<GlobalSystemMediaTransportControlsSessionManager> {
        let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?;
        op.get().ok()
    }

    pub fn get_current_session() -> Option<GlobalSystemMediaTransportControlsSession> {
        let mgr = get_session_manager()?;
        mgr.GetCurrentSession().ok()
    }

    fn clean_app_name(id: &str) -> String {
        let lower = id.to_lowercase();
        if lower.contains("spotify") {
            "Spotify".to_string()
        } else if lower.contains("chrome") {
            "Google Chrome".to_string()
        } else if lower.contains("msedge") {
            "Microsoft Edge".to_string()
        } else if lower.contains("firefox") {
            "Firefox".to_string()
        } else if lower.contains("applemusic") || lower.contains("apple music") {
            "Apple Music".to_string()
        } else if lower.contains("vlc") {
            "VLC Media Player".to_string()
        } else if lower.contains("zune") || lower.contains("groove") || lower.contains("mediaplayer") {
            "Media Player".to_string()
        } else {
            let clean = id.trim_end_matches(".exe");
            if let Some(pos) = clean.rfind('\\') {
                clean[pos + 1..].to_string()
            } else {
                clean.to_string()
            }
        }
    }

    fn current_windows_ticks() -> i64 {
        use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
        let ft = unsafe { GetSystemTimePreciseAsFileTime() };
        let ticks = (((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)) as i64;
        if ticks > 0 {
            ticks
        } else {
            const WINDOWS_TO_UNIX_TICKS: i64 = 116_444_736_000_000_000;
            match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                Ok(d) => WINDOWS_TO_UNIX_TICKS
                    .saturating_add((d.as_secs() as i64).saturating_mul(10_000_000))
                    .saturating_add(d.subsec_nanos() as i64 / 100),
                Err(_) => 0,
            }
        }
    }

    pub fn query_playback() -> Option<MusicPlaybackState> {
        let session = get_current_session()?;
        let info = session.GetPlaybackInfo().ok()?;
        let status = info.PlaybackStatus().ok()?;
        let is_playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;

        let media_op = session.TryGetMediaPropertiesAsync().ok()?;
        let media = media_op.get().ok()?;

        let title = media.Title().ok().map(|s| s.to_string()).filter(|s| !s.is_empty())?;
        let artist = media.Artist().ok().map(|s| s.to_string()).filter(|s| !s.is_empty());
        let album_title = media.AlbumTitle().ok().map(|s| s.to_string()).filter(|s| !s.is_empty());

        let raw_app_id = session.SourceAppUserModelId().ok().map(|s| s.to_string()).unwrap_or_default();
        let app_name = Some(clean_app_name(&raw_app_id));

        let mut position_secs = None;
        let mut duration_secs = None;

        if let Ok(timeline) = session.GetTimelineProperties() {
            let mut dur_val = None;
            if let Ok(end) = timeline.EndTime() {
                let dur = end.Duration as f64 / 10_000_000.0;
                if dur > 0.0 {
                    dur_val = Some(dur);
                    duration_secs = Some(dur);
                }
            }

            if let Ok(pos) = timeline.Position() {
                let mut current_pos = pos.Duration as f64 / 10_000_000.0;

                // WinRT TimelineProperties.Position is a snapshot taken at LastUpdatedTime.
                // Media players (Spotify, browsers, etc.) only update this snapshot periodically
                // or on state changes. When actively playing, calculate live playback position
                // by adding elapsed time since LastUpdatedTime.
                if is_playing {
                    if let Ok(last_updated) = timeline.LastUpdatedTime() {
                        let now_ticks = current_windows_ticks();
                        if last_updated.UniversalTime > 0 && now_ticks > last_updated.UniversalTime {
                            let elapsed_ticks = now_ticks - last_updated.UniversalTime;
                            let elapsed_secs = elapsed_ticks as f64 / 10_000_000.0;
                            if elapsed_secs >= 0.0 && elapsed_secs < 86_400.0 {
                                current_pos += elapsed_secs;
                            }
                        }
                    }
                }

                if let Some(dur) = dur_val {
                    current_pos = current_pos.clamp(0.0, dur);
                } else if current_pos < 0.0 {
                    current_pos = 0.0;
                }

                position_secs = Some(current_pos);
            }
        }

        let album_color = if raw_app_id.to_lowercase().contains("spotify") {
            Some("#1DB954".to_string())
        } else if raw_app_id.to_lowercase().contains("music") {
            Some("#FA2D48".to_string())
        } else {
            Some("#38BDF8".to_string())
        };

        Some(MusicPlaybackState {
            is_playing,
            title: Some(title),
            artist,
            album_title,
            album_art_url: None,
            album_color,
            bpm: Some(112),
            position_secs,
            duration_secs,
            app_name,
        })
    }

    pub fn toggle_play_pause() {
        if let Some(session) = get_current_session() {
            let _ = session.TryTogglePlayPauseAsync();
        }
    }

    pub fn skip_next() {
        if let Some(session) = get_current_session() {
            let _ = session.TrySkipNextAsync();
        }
    }

    pub fn skip_prev() {
        if let Some(session) = get_current_session() {
            let _ = session.TrySkipPreviousAsync();
        }
    }

    pub fn seek_to(position_secs: f64) {
        if let Some(session) = get_current_session() {
            let ticks = (position_secs * 10_000_000.0) as i64;
            let _ = session.TryChangePlaybackPositionAsync(ticks);
        }
    }
}

#[cfg(not(windows))]
mod non_win {
    use super::MusicPlaybackState;

    pub fn query_playback() -> Option<MusicPlaybackState> {
        None
    }

    pub fn toggle_play_pause() {}
    pub fn skip_next() {}
    pub fn skip_prev() {}
    pub fn seek_to(_position_secs: f64) {}
}

#[cfg(windows)]
use win::*;

#[cfg(not(windows))]
use non_win::*;

#[tauri::command]
pub fn get_media_playback(state: tauri::State<MediaState>) -> Option<MusicPlaybackState> {
    state.current.lock().unwrap().clone()
}

#[tauri::command]
pub fn media_play_pause() {
    toggle_play_pause();
}

#[tauri::command]
pub fn media_next() {
    skip_next();
}

#[tauri::command]
pub fn media_prev() {
    skip_prev();
}

#[tauri::command]
pub fn media_seek(position_secs: f64) {
    seek_to(position_secs);
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPayload {
    pub id: Option<i64>,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration: Option<f64>,
    pub instrumental: Option<bool>,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

fn is_valid_netease_lrc(synced: &str) -> bool {
    let mut valid_count = 0;
    for line in synced.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('[') {
            continue;
        }
        if let Some(pos) = trimmed.find(']') {
            let text = trimmed[pos + 1..].trim();
            if text.is_empty() {
                continue;
            }
            let text_lower = text.to_lowercase();
            if text.starts_with("作词")
                || text.starts_with("作曲")
                || text.starts_with("编曲")
                || text.starts_with("制作")
                || text.starts_with("监制")
                || text.starts_with("混音")
                || text.starts_with("母带")
                || text_lower.starts_with("written by")
                || text_lower.starts_with("composed by")
                || text_lower.starts_with("produced by")
                || text_lower.starts_with("lyrics by")
                || text_lower.starts_with("credits")
                || text_lower.starts_with("instrumental")
                || text_lower.starts_with("pure music")
            {
                continue;
            }
            valid_count += 1;
        }
    }
    valid_count >= 3
}

#[tauri::command]
pub async fn fetch_lyrics(
    title: String,
    artist: Option<String>,
    duration_secs: Option<f64>,
) -> Option<LyricsPayload> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .user_agent("CocoaNotch/0.2.4 (https://github.com/Rohitpvt/Cocoa-Notch)")
        .build()
        .ok()?;

    let raw_title = title.trim();
    if raw_title.is_empty() {
        return None;
    }

    let mut clean_t = raw_title.to_string();
    if let Some(pos) = clean_t.find('|') {
        clean_t = clean_t[..pos].trim().to_string();
    }
    if let Some(pos) = clean_t.find('/') {
        clean_t = clean_t[..pos].trim().to_string();
    }
    if let Some(open) = clean_t.find('(') {
        if let Some(close) = clean_t.rfind(')') {
            if close > open {
                clean_t = format!("{}{}", clean_t[..open].trim(), clean_t[close + 1..].trim()).trim().to_string();
            }
        }
    }
    if let Some(open) = clean_t.find('[') {
        if let Some(close) = clean_t.rfind(']') {
            if close > open {
                clean_t = format!("{}{}", clean_t[..open].trim(), clean_t[close + 1..].trim()).trim().to_string();
            }
        }
    }
    if let Some(pos) = clean_t.find(" - ") {
        let suffix = clean_t[pos + 3..].to_lowercase();
        if suffix.contains("from ")
            || suffix.contains("soundtrack")
            || suffix.contains("remaster")
            || suffix.contains("edit")
            || suffix.contains("version")
            || suffix.contains("live")
            || suffix.contains("acoustic")
            || suffix.contains("explicit")
            || suffix.contains("clean")
            || suffix.contains("slowed")
            || suffix.contains("sped")
        {
            clean_t = clean_t[..pos].trim().to_string();
        }
    }
    if clean_t.is_empty() {
        clean_t = raw_title.to_string();
    }

    let mut titles: Vec<String> = vec![clean_t.clone()];
    if !raw_title.is_empty() && !titles.contains(&raw_title.to_string()) {
        titles.push(raw_title.to_string());
    }
    if let Some(pos) = clean_t.find(" - ") {
        let base = clean_t[..pos].trim().to_string();
        if !base.is_empty() && !titles.contains(&base) {
            titles.push(base);
        }
    }

    let raw_artist = artist.as_deref().unwrap_or("").trim();
    let mut artists: Vec<String> = Vec::new();
    if !raw_artist.is_empty() {
        let first_part = raw_artist.split('·').next().unwrap_or(raw_artist).trim();
        artists.push(first_part.to_string());
        for sep in [", ", "; ", " & ", " / ", " feat. ", " ft. ", " with ", " x "] {
            for part in first_part.split(sep) {
                let trimmed = part.trim().to_string();
                if !trimmed.is_empty() && !artists.contains(&trimmed) {
                    artists.push(trimmed);
                }
            }
        }
        if !artists.contains(&raw_artist.to_string()) {
            artists.push(raw_artist.to_string());
        }
    } else {
        artists.push(String::new());
    }

    // Strategy 1: Exact GET without strict duration
    for t in &titles {
        for art in &artists {
            if let Ok(mut url) = Url::parse("https://lrclib.net/api/get") {
                url.query_pairs_mut()
                    .append_pair("track_name", t)
                    .append_pair("artist_name", art);
                if let Ok(resp) = client.get(url).send().await {
                    if resp.status().is_success() {
                        if let Ok(payload) = resp.json::<LyricsPayload>().await {
                            if payload.synced_lyrics.is_some() || payload.plain_lyrics.is_some() {
                                return Some(payload);
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 2: Exact GET with duration
    if let Some(dur) = duration_secs {
        if dur > 0.0 {
            let dur_str = (dur.round() as u64).to_string();
            for t in &titles {
                for art in &artists {
                    if let Ok(mut url) = Url::parse("https://lrclib.net/api/get") {
                        url.query_pairs_mut()
                            .append_pair("track_name", t)
                            .append_pair("artist_name", art)
                            .append_pair("duration", &dur_str);
                        if let Ok(resp) = client.get(url).send().await {
                            if resp.status().is_success() {
                                if let Ok(payload) = resp.json::<LyricsPayload>().await {
                                    if payload.synced_lyrics.is_some() || payload.plain_lyrics.is_some() {
                                        return Some(payload);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 3: Search endpoint on LRCLIB (structured track + artist)
    for t in &titles {
        for art in &artists {
            if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
                url.query_pairs_mut()
                    .append_pair("track_name", t)
                    .append_pair("artist_name", art);
                if let Ok(resp) = client.get(url).send().await {
                    if resp.status().is_success() {
                        if let Ok(mut list) = resp.json::<Vec<LyricsPayload>>().await {
                            if !list.is_empty() {
                                let mut synced: Vec<LyricsPayload> = list.drain(..).filter(|it| it.synced_lyrics.is_some()).collect();
                                let target_dur = duration_secs.unwrap_or(0.0);
                                if !synced.is_empty() {
                                    if target_dur > 0.0 {
                                        synced.sort_by(|a, b| {
                                            let da = (a.duration.unwrap_or(0.0) - target_dur).abs();
                                            let db = (b.duration.unwrap_or(0.0) - target_dur).abs();
                                            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                                        });
                                    }
                                    return Some(synced.remove(0));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 4: Full query search on LRCLIB (q = artist track)
    for t in &titles {
        for art in &artists {
            let q = if art.is_empty() { t.clone() } else { format!("{} {}", art, t) };
            if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
                url.query_pairs_mut().append_pair("q", &q);
                if let Ok(resp) = client.get(url).send().await {
                    if resp.status().is_success() {
                        if let Ok(mut list) = resp.json::<Vec<LyricsPayload>>().await {
                            let mut synced: Vec<LyricsPayload> = list.drain(..).filter(|it| it.synced_lyrics.is_some()).collect();
                            let target_dur = duration_secs.unwrap_or(0.0);
                            if !synced.is_empty() {
                                if target_dur > 0.0 {
                                    synced.sort_by(|a, b| {
                                        let da = (a.duration.unwrap_or(0.0) - target_dur).abs();
                                        let db = (b.duration.unwrap_or(0.0) - target_dur).abs();
                                        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                                    });
                                }
                                return Some(synced.remove(0));
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 5: Clean title-only search on LRCLIB
    for t in &titles {
        if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
            url.query_pairs_mut().append_pair("q", t);
            if let Ok(resp) = client.get(url).send().await {
                if resp.status().is_success() {
                    if let Ok(list) = resp.json::<Vec<LyricsPayload>>().await {
                        if let Some(item) = list.into_iter().find(|it| {
                            let has_lrc = it.synced_lyrics.is_some() || it.plain_lyrics.is_some();
                            if !has_lrc { return false; }
                            if artists.is_empty() || artists[0].is_empty() { return true; }
                            let it_art = it.artist_name.as_deref().unwrap_or("").to_lowercase();
                            artists.iter().any(|a| !a.is_empty() && it_art.contains(&a.to_lowercase()))
                        }) {
                            return Some(item);
                        }
                    }
                }
            }
        }
    }

    // Strategy 5.5: NetEase Cloud Music search & synced LRC
    for t in &titles {
        for art in &artists {
            let q = if art.is_empty() {
                t.clone()
            } else {
                format!("{} {}", art, t)
            };
            if let Ok(mut url) = Url::parse("https://music.163.com/api/search/get") {
                url.query_pairs_mut()
                    .append_pair("s", &q)
                    .append_pair("type", "1")
                    .append_pair("limit", "1");
                if let Ok(resp) = client.get(url).send().await {
                    if resp.status().is_success() {
                        if let Ok(search_val) = resp.json::<serde_json::Value>().await {
                            if let Some(song) = search_val
                                .get("result")
                                .and_then(|r| r.get("songs"))
                                .and_then(|s| s.as_array())
                                .and_then(|a| a.first())
                            {
                                if let Some(song_id) = song.get("id").and_then(|id| id.as_i64()) {
                                    if let Ok(mut lrc_url) = Url::parse("https://music.163.com/api/song/lyric") {
                                        lrc_url.query_pairs_mut()
                                            .append_pair("os", "pc")
                                            .append_pair("id", &song_id.to_string())
                                            .append_pair("lv", "-1")
                                            .append_pair("kv", "-1")
                                            .append_pair("tv", "-1");
                                        if let Ok(lrc_resp) = client.get(lrc_url).send().await {
                                            if lrc_resp.status().is_success() {
                                                if let Ok(lrc_val) = lrc_resp.json::<serde_json::Value>().await {
                                                    if let Some(synced) = lrc_val
                                                        .get("lrc")
                                                        .and_then(|l| l.get("lyric"))
                                                        .and_then(|s| s.as_str())
                                                    {
                                                        if is_valid_netease_lrc(synced) {
                                                            let song_name = song
                                                                .get("name")
                                                                .and_then(|n| n.as_str())
                                                                .map(|s| s.to_string());
                                                            return Some(LyricsPayload {
                                                                id: Some(song_id),
                                                                track_name: song_name.or_else(|| Some(t.clone())),
                                                                artist_name: if art.is_empty() { None } else { Some(art.clone()) },
                                                                album_name: None,
                                                                duration: duration_secs,
                                                                plain_lyrics: None,
                                                                synced_lyrics: Some(synced.to_string()),
                                                                instrumental: Some(false),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 5.8: Genius search and open lyrics extraction (high-accuracy global coverage)
    for t in &titles {
        for art in &artists {
            let q = if art.is_empty() {
                t.clone()
            } else {
                format!("{} {}", art, t)
            };
            let mut search_url = match Url::parse("https://genius.com/api/search/multi") {
                Ok(u) => u,
                Err(_) => continue,
            };
            search_url.query_pairs_mut()
                .append_pair("per_page", "5")
                .append_pair("q", &q);

            let search_res = match client
                .get(search_url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };

            if let Ok(search_val) = search_res.json::<serde_json::Value>().await {
                let sections = search_val
                    .get("response")
                    .and_then(|r| r.get("sections"))
                    .and_then(|s| s.as_array());

                if let Some(sections) = sections {
                    let mut song_path: Option<String> = None;
                    let mut song_title: Option<String> = None;
                    let mut artist_name: Option<String> = None;

                    for sec in sections {
                        let sec_type = sec.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if sec_type == "song" || sec_type == "top_hit" {
                            if let Some(hits) = sec.get("hits").and_then(|h| h.as_array()) {
                                for hit in hits {
                                    let htype = hit.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    if htype == "song" {
                                        if let Some(result) = hit.get("result") {
                                            if let Some(path) = result.get("path").and_then(|p| p.as_str()) {
                                                let title_str = result.get("title").and_then(|t| t.as_str()).unwrap_or("");
                                                let title_lower = title_str.to_lowercase();
                                                if title_lower.contains("tracklist")
                                                    || title_lower.contains("annotated")
                                                    || (title_lower.contains("instrumental") && !t.to_lowercase().contains("instrumental"))
                                                {
                                                    continue;
                                                }
                                                song_path = Some(path.to_string());
                                                song_title = Some(title_str.to_string());
                                                artist_name = result
                                                    .get("primary_artist")
                                                    .and_then(|a| a.get("name"))
                                                    .and_then(|n| n.as_str())
                                                    .map(|s| s.to_string());
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if song_path.is_some() {
                            break;
                        }
                    }

                    if let Some(path) = song_path {
                        let page_url = format!("https://genius.com{}", path);
                        if let Ok(page_res) = client
                            .get(&page_url)
                            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                            .send()
                            .await
                        {
                            if page_res.status().is_success() {
                                if let Ok(html) = page_res.text().await {
                                    let parts: Vec<&str> = html.split("data-lyrics-container=\"true\"").collect();
                                    if parts.len() > 1 {
                                        let mut full_lyrics = String::new();
                                        for part in &parts[1..] {
                                            if let Some(start_idx) = part.find('>') {
                                                let mut content = &part[start_idx + 1..];
                                                if let Some(end_idx) = content.find("<div class=\"Lyrics__Footer")
                                                    .or_else(|| content.find("<div class=\"RightSidebar"))
                                                    .or_else(|| content.find("<section"))
                                                    .or_else(|| content.find("<div class=\"SongHeader"))
                                                {
                                                    content = &content[..end_idx];
                                                }
                                                let with_newlines = content
                                                    .replace("<br>", "\n")
                                                    .replace("<br/>", "\n")
                                                    .replace("<br />", "\n");
                                                let mut in_tag = false;
                                                for ch in with_newlines.chars() {
                                                    if ch == '<' {
                                                        in_tag = true;
                                                    } else if ch == '>' {
                                                        in_tag = false;
                                                    } else if !in_tag {
                                                        full_lyrics.push(ch);
                                                    }
                                                }
                                                full_lyrics.push('\n');
                                            }
                                        }

                                        let unescaped = full_lyrics
                                            .replace("&amp;", "&")
                                            .replace("&lt;", "<")
                                            .replace("&gt;", ">")
                                            .replace("&quot;", "\"")
                                            .replace("&#x27;", "'")
                                            .replace("&#8217;", "'")
                                            .replace("&#8216;", "'")
                                            .replace("&rsquo;", "'")
                                            .replace("&lsquo;", "'")
                                            .replace("&#8220;", "\"")
                                            .replace("&#8221;", "\"")
                                            .replace("&ldquo;", "\"")
                                            .replace("&rdquo;", "\"")
                                            .replace("&mdash;", "—")
                                            .replace("&#8212;", "—")
                                            .replace("&ndash;", "–")
                                            .replace("&#8211;", "–")
                                            .replace("&hellip;", "…")
                                            .replace("&#8230;", "…")
                                            .replace('\u{00a0}', " ");

                                        let clean_lines: Vec<&str> = unescaped
                                            .lines()
                                            .map(|l| l.trim())
                                            .filter(|l| {
                                                if l.is_empty() || (l.starts_with('[') && l.ends_with(']')) {
                                                    return false;
                                                }
                                                let lower = l.to_lowercase();
                                                if lower.contains("contributors")
                                                    || lower.contains("translations")
                                                    || lower.ends_with("lyrics")
                                                    || lower.starts_with("written by")
                                                    || lower.starts_with("produced by")
                                                    || lower.starts_with("composed by")
                                                    || lower.starts_with("lyrics by")
                                                    || l.starts_with("作词")
                                                    || l.starts_with("作曲")
                                                {
                                                    return false;
                                                }
                                                true
                                            })
                                            .collect();

                                        if clean_lines.len() >= 3 {
                                            return Some(LyricsPayload {
                                                track_name: song_title.or_else(|| Some(t.clone())),
                                                artist_name: artist_name.or_else(|| if art.is_empty() { None } else { Some(art.clone()) }),
                                                plain_lyrics: Some(clean_lines.join("\n")),
                                                synced_lyrics: None,
                                                duration: duration_secs,
                                                instrumental: Some(false),
                                                ..Default::default()
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 6: Fallback to Lyrics.ovh for plain lyrics (with proper URL path encoding)
    for t in &titles {
        for art in &artists {
            if art.is_empty() {
                continue;
            }
            let mut url = match Url::parse("https://api.lyrics.ovh/v1/") {
                Ok(u) => u,
                Err(_) => continue,
            };
            if let Ok(mut segs) = url.path_segments_mut() {
                segs.push(art);
                segs.push(t);
            }
            if let Ok(resp) = client.get(url).send().await {
                if resp.status().is_success() {
                    #[derive(Deserialize)]
                    struct OvhResp {
                        lyrics: Option<String>,
                    }
                    if let Ok(ovh) = resp.json::<OvhResp>().await {
                        if let Some(plain) = ovh.lyrics {
                            let trimmed = plain.trim();
                            if !trimmed.is_empty() {
                                return Some(LyricsPayload {
                                    track_name: Some(t.clone()),
                                    artist_name: Some(art.clone()),
                                    plain_lyrics: Some(trimmed.to_string()),
                                    synced_lyrics: None,
                                    instrumental: Some(false),
                                    ..Default::default()
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

pub fn start(app: AppHandle, state: std::sync::Arc<MediaState>) {
    std::thread::Builder::new()
        .name("cocoa-media".into())
        .spawn(move || {
            let mut last_emitted: Option<MusicPlaybackState> = None;

            loop {
                let current = query_playback();

                let should_emit = match (&current, &last_emitted) {
                    (None, None) => false,
                    (Some(curr), Some(prev)) => {
                        curr.is_playing != prev.is_playing
                            || curr.title != prev.title
                            || curr.artist != prev.artist
                            || curr.is_playing
                    }
                    _ => true,
                };

                if should_emit {
                    *state.current.lock().unwrap() = current.clone();
                    let _ = app.emit_to(WINDOW_LABEL, "music-playback", current.clone());
                    let _ = app.emit("music-playback", current.clone());
                    last_emitted = current.clone();
                }

                let sleep_ms = match &current {
                    Some(c) if c.is_playing => 800,
                    _ => 1500,
                };
                std::thread::sleep(Duration::from_millis(sleep_ms));
            }
        })
        .expect("could not start media watcher");
}
