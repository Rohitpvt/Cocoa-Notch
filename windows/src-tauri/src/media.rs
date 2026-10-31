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

#[tauri::command]
pub async fn fetch_lyrics(
    title: String,
    artist: Option<String>,
    duration_secs: Option<f64>,
) -> Option<LyricsPayload> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
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
    if clean_t.is_empty() {
        clean_t = raw_title.to_string();
    }

    let raw_artist = artist.as_deref().unwrap_or("").trim();
    let mut artists: Vec<String> = Vec::new();
    if !raw_artist.is_empty() {
        let first_part = raw_artist.split('·').next().unwrap_or(raw_artist).trim();
        artists.push(first_part.to_string());
        let primary = first_part
            .split(&[',', ';', '&', '/'][..])
            .next()
            .unwrap_or(first_part)
            .split(" feat. ")
            .next()
            .unwrap_or(first_part)
            .split(" ft. ")
            .next()
            .unwrap_or(first_part)
            .trim();
        if !primary.is_empty() && primary != first_part {
            artists.push(primary.to_string());
        }
    } else {
        artists.push(String::new());
    }

    let mut lrclib_down = false;

    // Strategy 1: Exact GET without strict duration
    for art in &artists {
        if lrclib_down {
            break;
        }
        if let Ok(mut url) = Url::parse("https://lrclib.net/api/get") {
            url.query_pairs_mut()
                .append_pair("track_name", &clean_t)
                .append_pair("artist_name", art);
            match client.get(url).send().await {
                Ok(resp) => {
                    if resp.status().is_server_error() {
                        lrclib_down = true;
                        break;
                    } else if resp.status().is_success() {
                        if let Ok(payload) = resp.json::<LyricsPayload>().await {
                            if payload.synced_lyrics.is_some() || payload.plain_lyrics.is_some() {
                                return Some(payload);
                            }
                        }
                    }
                }
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        lrclib_down = true;
                        break;
                    }
                }
            }
        }
    }

    // Strategy 2: Exact GET with duration
    if !lrclib_down {
        if let Some(dur) = duration_secs {
            if dur > 0.0 {
                let dur_str = (dur.round() as u64).to_string();
                for art in &artists {
                    if lrclib_down {
                        break;
                    }
                    if let Ok(mut url) = Url::parse("https://lrclib.net/api/get") {
                        url.query_pairs_mut()
                            .append_pair("track_name", &clean_t)
                            .append_pair("artist_name", art)
                            .append_pair("duration", &dur_str);
                        match client.get(url).send().await {
                            Ok(resp) => {
                                if resp.status().is_server_error() {
                                    lrclib_down = true;
                                    break;
                                } else if resp.status().is_success() {
                                    if let Ok(payload) = resp.json::<LyricsPayload>().await {
                                        if payload.synced_lyrics.is_some() || payload.plain_lyrics.is_some() {
                                            return Some(payload);
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                if e.is_timeout() || e.is_connect() {
                                    lrclib_down = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Strategy 3: Search endpoint on LRCLIB
    if !lrclib_down {
        for art in &artists {
            if lrclib_down {
                break;
            }
            if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
                url.query_pairs_mut()
                    .append_pair("track_name", &clean_t)
                    .append_pair("artist_name", art);
                match client.get(url).send().await {
                    Ok(resp) => {
                        if resp.status().is_server_error() {
                            lrclib_down = true;
                            break;
                        } else if resp.status().is_success() {
                            if let Ok(list) = resp.json::<Vec<LyricsPayload>>().await {
                                if let Some(item) = list.into_iter().find(|it| it.synced_lyrics.is_some() || it.plain_lyrics.is_some()) {
                                    return Some(item);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        if e.is_timeout() || e.is_connect() {
                            lrclib_down = true;
                            break;
                        }
                    }
                }
            }
        }
    }

    // Strategy 4: Full query search
    if !lrclib_down {
        let query = format!("{} {}", artists.first().map(|s| s.as_str()).unwrap_or(""), clean_t).trim().to_string();
        if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
            url.query_pairs_mut().append_pair("q", &query);
            match client.get(url).send().await {
                Ok(resp) => {
                    if resp.status().is_server_error() {
                        lrclib_down = true;
                    } else if resp.status().is_success() {
                        if let Ok(list) = resp.json::<Vec<LyricsPayload>>().await {
                            if let Some(item) = list.into_iter().find(|it| it.synced_lyrics.is_some() || it.plain_lyrics.is_some()) {
                                return Some(item);
                            }
                        }
                    }
                }
                Err(e) => {
                    if e.is_timeout() || e.is_connect() {
                        lrclib_down = true;
                    }
                }
            }
        }
    }

    // Strategy 5: Clean title-only search
    if !lrclib_down {
        if let Ok(mut url) = Url::parse("https://lrclib.net/api/search") {
            url.query_pairs_mut().append_pair("q", &clean_t);
            match client.get(url).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        if let Ok(list) = resp.json::<Vec<LyricsPayload>>().await {
                            if let Some(item) = list.into_iter().find(|it| it.synced_lyrics.is_some() || it.plain_lyrics.is_some()) {
                                return Some(item);
                            }
                        }
                    }
                }
                Err(_) => {}
            }
        }
    }

    // Strategy 6: Fallback to Lyrics.ovh for plain lyrics (with proper URL path encoding)
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
            segs.push(&clean_t);
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
                                track_name: Some(clean_t.clone()),
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
