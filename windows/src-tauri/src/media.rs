// Universal Media Playback & Controls Listener (Windows GSMTC)
// Powered by Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager
// Supports Spotify, YouTube Music, Apple Music, and any browser/media app.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
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
        let mut ft = windows::Win32::Foundation::FILETIME::default();
        unsafe {
            GetSystemTimePreciseAsFileTime(&mut ft);
        }
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
