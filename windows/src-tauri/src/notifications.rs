// Windows system-wide notification listener.
// Captures toast notifications from any app / software and forwards them to the island.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotification {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub body: String,
    pub timestamp: u64,
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("coucou-notifications".into())
        .spawn(move || {
            run_listener(app);
        })
        .expect("could not start notification listener");
}

#[cfg(not(windows))]
pub fn start(_app: AppHandle) {}

#[cfg(windows)]
fn run_listener(app: AppHandle) {
    use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
    use windows::UI::Notifications::NotificationKinds;
    use windows::UI::Notifications::KnownNotificationBindings;

    // Check if UserNotificationListener is supported on this Windows version
    let listener = match UserNotificationListener::Current() {
        Ok(l) => l,
        Err(e) => {
            crate::log::line(format!("UserNotificationListener::Current failed: {e}"));
            return;
        }
    };

    let status = match listener.GetAccessStatus() {
        Ok(s) => s,
        Err(e) => {
            crate::log::line(format!("UserNotificationListener::GetAccessStatus failed: {e}"));
            return;
        }
    };

    if status != UserNotificationListenerAccessStatus::Allowed {
        if let Ok(async_op) = listener.RequestAccessAsync() {
            if let Ok(res) = async_op.get() {
                crate::log::line(format!("Notification access status: {res:?}"));
            }
        }
    }

    let mut seen_ids: HashSet<u32> = HashSet::new();
    let mut seen_id_order: VecDeque<u32> = VecDeque::new();
    let mut recent_content: HashMap<(String, String, String), u64> = HashMap::new();
    let mut initial_scan = true;

    loop {
        std::thread::sleep(Duration::from_millis(800));

        let notifications_op = match listener.GetNotificationsAsync(NotificationKinds::Toast) {
            Ok(op) => op,
            Err(_) => continue,
        };

        let notifications = match notifications_op.get() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let count = match notifications.Size() {
            Ok(c) => c,
            Err(_) => continue,
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        for i in 0..count {
            if let Ok(un) = notifications.GetAt(i) {
                let id = un.Id().unwrap_or(0);

                if id != 0 && seen_ids.contains(&id) {
                    continue;
                }

                let app_name = un.AppInfo()
                    .and_then(|info| info.DisplayInfo())
                    .and_then(|disp| disp.DisplayName())
                    .map(|h| h.to_string())
                    .unwrap_or_else(|_| "System".to_string());

                let mut title = String::new();
                let mut body = String::new();

                if let Ok(notif) = un.Notification() {
                    if let Ok(visual) = notif.Visual() {
                        let generic_binding = KnownNotificationBindings::ToastGeneric().unwrap_or_default();
                        if let Ok(binding) = visual.GetBinding(&generic_binding) {
                            if let Ok(text_elements) = binding.GetTextElements() {
                                if let Ok(elem_count) = text_elements.Size() {
                                    for idx in 0..elem_count {
                                        if let Ok(elem) = text_elements.GetAt(idx) {
                                            if let Ok(text) = elem.Text() {
                                                let t = text.to_string();
                                                if idx == 0 {
                                                    title = t;
                                                } else if body.is_empty() {
                                                    body = t;
                                                } else {
                                                    body.push_str(" ");
                                                    body.push_str(&t);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Fallback if title is empty
                if title.is_empty() && !body.is_empty() {
                    title = app_name.clone();
                } else if title.is_empty() && body.is_empty() {
                    title = format!("{app_name} Notification");
                }

                // Content fingerprint deduplication (45-second cooldown for identical content)
                let fingerprint = (app_name.clone(), title.clone(), body.clone());
                if let Some(&last_seen) = recent_content.get(&fingerprint) {
                    if now.saturating_sub(last_seen) < 45 {
                        if id != 0 && !seen_ids.contains(&id) {
                            seen_ids.insert(id);
                            seen_id_order.push_back(id);
                        }
                        continue;
                    }
                }

                // Mark seen
                if id != 0 {
                    seen_ids.insert(id);
                    seen_id_order.push_back(id);
                    while seen_id_order.len() > 1000 {
                        if let Some(old_id) = seen_id_order.pop_front() {
                            seen_ids.remove(&old_id);
                        }
                    }
                }
                recent_content.insert(fingerprint, now);

                if !initial_scan {
                    let payload = SystemNotification {
                        id,
                        app_name,
                        title,
                        body,
                        timestamp: now,
                    };

                    crate::log::line(format!(
                        "System notification [#{}] {}: {} ({})",
                        payload.id, payload.app_name, payload.title, payload.body
                    ));
                    let _ = app.emit("system-notification", &payload);
                }
            }
        }

        // Periodically purge fingerprints older than 300 seconds
        if recent_content.len() > 100 {
            recent_content.retain(|_, ts| now.saturating_sub(*ts) < 300);
        }

        initial_scan = false;
    }
}
