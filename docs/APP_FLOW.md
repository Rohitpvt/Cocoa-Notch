# Cocoa Notch — Application Flow & State Lifecycles

## 1. Executive Summary & Purpose

**Cocoa Notch** (known natively as `NotchBuddy` on macOS, Cocoa for Windows/Linux on Tauri 2, and `CocoaPhone` on iOS) is an ambient developer companion and AI coding agent orchestrator. It sits within the hardware display notch on modern MacBooks, at the screen top bar on external displays and Windows/Linux desktops, and synchronizes to the iOS Dynamic Island and Lock Screen.

This document outlines the end-to-end operational flows, user interaction paradigms, state machines, IPC pipelines, cross-device synchronization loops, and lifecycle transitions across all supported platforms.

---

## 2. High-Level System Flow Diagram

```mermaid
flowchart TD
    subgraph AgentEnvironment["Developer Workspace & Agent Runtimes"]
        Claude[Claude Code CLI]
        Codex[Codex / Cursor]
        Gemini[Gemini CLI / Antigravity]
        OtherAgents[Custom Agents / MCP Tools]
    end

    subgraph IPCRelay["IPC Relay Layer"]
        UnixSock["Unix Domain Socket (/tmp/cocoa.sock)"]
        WinPipe["Windows Named Pipe (\\\\.\\pipe\\cocoa-agent)"]
        HookRelay["cocoa-hook / nb-hook CLI Relay"]
    end

    subgraph DesktopRuntime["Host Desktop Application (macOS AppKit / Tauri Rust)"]
        EventServer["HookServer.swift / pipe.rs"]
        Router["Event Router & Pill Mapper"]
        FSM["Island State Machine (Hidden/Peek/Compact/Expanded)"]
        CanvasEngine["Mochi BotEngine (Canvas / Vector Graphics)"]
        AppKitView["Island Window / Tauri Webview Overlay"]
        DesktopMochi["Desktop Companion (Detached Window)"]
    end

    subgraph Persistence["Persistence & Security"]
        Keychain["OS Keychain / Credential Manager"]
        RecapJSON["Local 12-Week Rolling Recap (recap.json)"]
    end

    subgraph CloudSync["Mobile Handoff & Edge Relay"]
        CloudKit["Apple CloudKit (Private Database Zone 'Cocoa')"]
        CFWorker["Stateless Cloudflare Relay Worker"]
        APNs["Apple Push Notification Service (Live Activities)"]
    end

    subgraph MobileRuntime["iOS Companion (CocoaPhone)"]
        DynamicIsland["Dynamic Island & Lock Screen Live Activity"]
        AppIntents["Actionable Notification & Siri Shortcuts"]
        PhoneUI["SwiftUI Mobile App (Sessions, Diffs, Services)"]
    end

    Claude -->|Hook Events| HookRelay
    Codex -->|Hook Events| HookRelay
    Gemini -->|Hook Events| HookRelay
    OtherAgents -->|Hook Events| HookRelay

    HookRelay -->|macOS / Linux| UnixSock
    HookRelay -->|Windows| WinPipe

    UnixSock --> EventServer
    WinPipe --> EventServer

    EventServer --> Router
    Router --> FSM
    Router --> RecapJSON
    Keychain -.->|API Tokens| Router

    FSM --> CanvasEngine
    CanvasEngine --> AppKitView
    FSM -.->|Detach Drag| DesktopMochi

    Router -->|Publish Session| CloudKit
    CloudKit --> CFWorker
    CFWorker --> APNs
    APNs --> DynamicIsland
    CloudKit --> PhoneUI
    DynamicIsland -->|Biometric Decision| CloudKit
    CloudKit -.->|Decision Sync| Router
```

---

## 3. Island Display States & Geometry

The island interface adheres to strict dimensions and geometric constraints depending on the host hardware (presence of a physical MacBook display notch vs. flat displays):

```mermaid
stateDiagram-v2
    [*] --> Hidden: No active agent sessions
    Hidden --> Peek: Cursor hovers screen top / notch
    Peek --> Hidden: Mouse leaves (<650ms)
    Peek --> Expanded: Mouse dwells >650ms
    Hidden --> Compact: Agent starts working
    Compact --> Expanded: Hover (>200ms) OR Click Mochi
    Expanded --> Compact: Inactivity (>60s) OR Escape key
    Compact --> Hidden: Inactivity / User absent (>3m)
    Hidden --> Expanded: Critical Alert (Permission / Question / Error)
    Expanded --> Desktop: Drag Mochi out of Island
    Desktop --> Compact: Double-click Mochi / Alert triggers return
```

### 3.1 Island Geometric Specifications

| Mode | Width (macOS Notch) | Height (macOS Notch) | Width (Windows / No Notch) | Height (Windows / No Notch) | Mochi Diameter | Sub-Agent Grid |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`hidden`** | $wN$ (physical notch width, ~184pt) | $hN$ (safe area top, ~32pt) | 80pt | 24pt | Hidden ($0\text{pt}$) | Inactive |
| **`peek`** | $wN + 64\text{pt}$ | $hN$ | 148pt | 24pt | $\varnothing 18\text{pt}$ | Inactive |
| **`compact`** | $wN + 104\text{pt}$ | $hN$ | 240pt | 24pt | $\varnothing 20\text{pt}$ | $2 \times 2$ mini-bot matrix |
| **`expanded`** | $640\text{pt}$ | Dynamic ($136\text{pt} - 320\text{pt}$) | $640\text{pt}$ | Dynamic ($136\text{pt} - 320\text{pt}$) | $\varnothing 44\text{pt} - 70\text{pt}$ | Vertical right-hand column |

### 3.2 Inactivity & Dismissal Rules
1. **Zero-Work Idle**: If no agents are actively running and no alerts are pending, the island retracts to `hidden` mode. In this mode, background CPU consumption is strictly **0.0%**.
2. **Auto-Dismiss Countdown**: In `expanded` mode with no active user input, a 60-second timer initiates. During the final 10 seconds, a visual $2\text{pt}$ white progress bar (shrinking from $160\text{pt}$ to $0\text{pt}$) signals imminent retraction.
3. **Absence Detection**: Polling mouse movement via `NSEvent.mouseLocation` (macOS) or Windows cursor hooks; if inactive for 3 minutes (configurable), the island transitions from `compact` to `hidden` until cursor movement resumes.
4. **Alert Override**: Any inbound permission request (`approval`), interactive selection (`question`), or execution failure (`error`) forcefully opens the island regardless of absence, remaining open until the developer responds.

---

## 4. Agent Interception & Hook Lifecycle

Cocoa acts as an external observability and approval hook. The lifecycle begins when a supported AI CLI or IDE extension triggers an event.

```mermaid
sequenceDiagram
    autonumber
    actor Developer
    participant Agent as Claude Code / Codex
    participant Hook as cocoa-hook (Relay)
    participant Daemon as Cocoa Daemon (HookServer/pipe.rs)
    participant UI as Island UI (Mochi)
    participant Phone as CocoaPhone (iOS)

    Developer->>Agent: claude "Refactor auth middleware"
    Agent->>Hook: Hook event: UserPromptSubmit (JSON payload via stdin)
    Hook->>Daemon: Relay JSON over IPC Socket / Named Pipe
    Daemon->>UI: Update state to 'working' (Mochi enters focus, ticker starts)
    UI-->>Developer: Mochi begins typing animation & eye-tracking cursor

    Agent->>Hook: PreToolUse (Tool: "Bash", Command: "npm test")
    Hook->>Daemon: Inbound Permission Request
    Daemon->>UI: Transition to 'approval' view (Code block + Allow/Deny buttons)
    Daemon->>Phone: Push APNs Live Activity update (Lock Screen)

    alt Approved on Desktop
        Developer->>UI: Click 'Allow' (or press Enter)
        UI->>Daemon: Decision: 'allow'
        Daemon-->>Hook: ACK response: {"decision": "allow"}
        Hook-->>Agent: Exit code 0 (Execution authorized)
    else Approved on iPhone
        Developer->>Phone: Tap 'Allow' with Face ID biometric validation
        Phone->>Daemon: Sync decision via CloudKit
        Daemon-->>Hook: ACK response: {"decision": "allow"}
        Hook-->>Agent: Exit code 0 (Execution authorized)
    else Denied
        Developer->>UI: Click 'Deny'
        UI->>Daemon: Decision: 'deny'
        Daemon-->>Hook: Reject response: {"decision": "deny"}
        Hook-->>Agent: Exit code 1 (Execution blocked)
    end

    Agent->>Hook: PostToolUse (Tool completion, diff generated)
    Hook->>Daemon: Event update (lines added/removed, updated files)
    Daemon->>UI: Update live diff ticker in expanded view

    Agent->>Hook: Stop (Session finished)
    Hook->>Daemon: Stop event payload with summary
    Daemon->>UI: Transition to 'finished' view (Mochi happy jump, sound 'finish.wav')
    Daemon->>Daemon: Record turn in local recap.json
```

---

## 5. View Hierarchies & Expansion States

When in `expanded` mode ($640\text{pt}$ width), Cocoa dynamically adjusts its card height and layout based on the active event context:

```mermaid
classDiagram
    class IslandExpandedView {
        +Header (34pt: Tabs, Active Count, Sound Toggle)
        +LeftCard (Focused Agent Details)
        +RightCard / RightColumn (Sub-agents or Service Details)
    }

    class OverviewView {
        +Height: 196pt
        +LeftCard: Agent status + Animated 4-line Ticker
        +RightCard: Active pill matrix & service badges
    }

    class ApprovalView {
        +Height: 206pt
        +Command snippet block
        +Action buttons: Allow (Y), Always Allow, Deny (N)
    }

    class QuestionView {
        +Height: 196pt
        +Question title (1/N)
        +Choice buttons (Single/Multi-select)
        +Custom input trigger ('Other...')
        +Fallback: 'Reply in terminal'
    }

    class ErrorView {
        +Height: 190pt
        +Error badge (#FF8D97)
        +Stack trace / Reason snippet
        +Retry / Open in external debugger
    }

    class FinishedView {
        +Height: 170pt
        +Turn summary & execution metrics
        +Terminal link button
        +Dismiss button (Auto-closes in 5.2s)
    }

    class ChatView {
        +Height: 156pt - 320pt
        +Context pill + Model selector
        +Markdown streaming response
        +Microphone dictation button
    }

    class FileDropView {
        +Height: 176pt
        +Mochi 'swallow box' animation
        +Actions: Ask Claude / Send via Email
    }

    IslandExpandedView <|-- OverviewView
    IslandExpandedView <|-- ApprovalView
    IslandExpandedView <|-- QuestionView
    IslandExpandedView <|-- ErrorView
    IslandExpandedView <|-- FinishedView
    IslandExpandedView <|-- ChatView
    IslandExpandedView <|-- FileDropView
```

---

## 6. Desktop Mochi Detachment Physics

Developers can detach Mochi from the notch to float as an interactive desktop companion:

1. **Drag Initiation**: Dragging Mochi beyond a $40\text{pt}$ downward threshold from the notch detaches the view.
2. **Window Transition**: The main island panel creates a dedicated transparent borderless window (`DesktopMochi.swift` / `desktop.rs`) sized at $120\text{pt} \times 120\text{pt}$.
3. **Cursor Tracking & Physics**:
   - Mochi's eyes follow the global pointer using spherical coordinate math.
   - Idling displays gentle vertical breathing oscillation ($0.05\text{Hz}$).
   - Three consecutive rapid clicks trigger the "dizzy" animation state with spinning spiral eyes.
   - Hovering for $>2$ seconds triggers heart float particles.
4. **Docking & Recall**:
   - Double-clicking Mochi triggers a smooth spring fly-back animation to the notch.
   - Any high-priority alert (Permission, Question, Error) automatically recalls Mochi to the notch header.

---

## 7. Cross-Device CloudKit & Live Activity Sync

```mermaid
sequenceDiagram
    participant Mac as macOS NotchBuddy
    participant CK as iCloud Private CloudKit
    participant CF as Cloudflare Worker Relay
    participant APNs as Apple Push Notification Service
    participant iOS as iPhone (CocoaPhone)

    Mac->>Mac: Screen locks / Developer walks away
    Mac->>CK: Write record: CKRecord(recordType: "Session")
    Note over Mac,CK: Encrypted fields: project, commands, questions
    CK->>CF: CloudKit Database Subscription Webhook
    CF->>CF: Verify APNs Auth Token (Held securely in Cloudflare secrets)
    CF->>APNs: Send ActivityPushPayload (Live Activity Token)
    APNs->>iOS: Present Dynamic Island & Lock Screen Live Activity

    Developer->>iOS: Authenticate Face ID & Tap "Allow"
    iOS->>CK: Write decision record: "allow" for approvalFingerprint
    CK->>Mac: Push silent CloudKit Notification
    Mac->>Mac: Validate fingerprint matches pending request
    Mac-->>Developer: Execute approved agent command
```

---

## 8. Developer Welfare & Wellness Workflow

Cocoa integrates proactive health monitoring to mitigate developer fatigue:

```mermaid
flowchart LR
    Start([Timer Started]) --> CheckInterval{Interval elapsed? e.g. 50m}
    CheckInterval -- No --> Idle[Sleep]
    CheckInterval -- Yes --> EvaluateTime{Time > 23:00?}
    
    EvaluateTime -- Yes --> NightOwlAlert[Trigger Gentle Late-Night Wind-Down]
    EvaluateTime -- No --> SelectPrompt{Select Reminder Type}

    SelectPrompt --> Hydration[Hydration Check-in 💧]
    SelectPrompt --> EyeRest[20-20-20 Eye Relaxation 👁️]
    SelectPrompt --> Posture[Spine & Posture Check 🧘]
    SelectPrompt --> Stretch[Physical Stretch Break 🚶]

    Hydration --> RenderNotification[Display Mochi Floating Toast]
    EyeRest --> RenderNotification
    Posture --> RenderNotification
    Stretch --> RenderNotification

    RenderNotification --> Action{User Interaction}
    Action --> Snooze[Snooze 10 mins]
    Action --> Thanks[Click 'Thanks Mochi! ✨']
    Action --> Ignore[Auto-dismiss 15s]
    
    Thanks --> HeartParticles[Mochi Smiles & Hearts Float]
    HeartParticles --> Start
    Snooze --> Start
    Ignore --> Start
```

---

## 9. Error Recovery & Fail-Safe Mechanics

| Failure Mode | Impact | Automatic Mitigation & Fallback |
| :--- | :--- | :--- |
| **Daemon Crash / Disconnect** | Hook cannot deliver payload | `cocoa-hook` sets a strict $200\text{ms}$ timeout. If Cocoa does not acknowledge, the hook exits cleanly (`code 0`), allowing CLI agents to operate without blocking. |
| **Corrupted Config (`settings.json`)** | Invalid user settings | Settings parser strictly validates JSON. Before writing, a dated timestamped backup (`settings.json.bak.<timestamp>`) is created. If parsing fails, defaults apply. |
| **CloudKit Sync Network Offline** | Mobile handoff delayed | Local decisions take priority. If no iPhone response occurs within $30\text{s}$, the desktop UI displays a prompt to decide locally. |
| **Multiple Simultaneous Alerts** | Alert collision | FIFO Alert Queue: Only one interactive alert modal renders at a time. Secondary alerts queue in the right-hand mini-bot column. |
