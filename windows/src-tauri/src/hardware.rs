// Hardware telemetry: live CPU, RAM, GPU usage and GPU temperature monitoring.
// Polled only while the island is visible; parked when hidden so it costs ~0% CPU.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::island::{PollGate, WINDOW_LABEL};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_usage: f64,
    pub ram_usage: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub gpu_usage: Option<f64>,
    pub gpu_temp: Option<f64>,
    pub gpu_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessoryDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub battery: u8,
    pub left_bud: Option<u8>,
    pub right_bud: Option<u8>,
    pub case_battery: Option<u8>,
    pub connected: bool,
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    fn ft_to_u64(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
    }

    pub struct CpuTracker {
        last_idle: u64,
        last_kernel: u64,
        last_user: u64,
        last_val: f64,
    }

    impl CpuTracker {
        pub fn new() -> Self {
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            unsafe {
                let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
            }
            Self {
                last_idle: ft_to_u64(idle),
                last_kernel: ft_to_u64(kernel),
                last_user: ft_to_u64(user),
                last_val: 0.0,
            }
        }

        pub fn get_usage(&mut self) -> f64 {
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            unsafe {
                if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_err() {
                    return self.last_val;
                }
            }
            let idle_u = ft_to_u64(idle);
            let kernel_u = ft_to_u64(kernel);
            let user_u = ft_to_u64(user);

            let idle_diff = idle_u.saturating_sub(self.last_idle);
            let kernel_diff = kernel_u.saturating_sub(self.last_kernel);
            let user_diff = user_u.saturating_sub(self.last_user);
            let total_diff = kernel_diff + user_diff;

            self.last_idle = idle_u;
            self.last_kernel = kernel_u;
            self.last_user = user_u;

            if total_diff > 0 {
                let idle_ratio = idle_diff as f64 / total_diff as f64;
                let usage = (1.0 - idle_ratio) * 100.0;
                self.last_val = usage.clamp(0.0, 100.0);
            }
            self.last_val
        }
    }

    pub fn get_ram() -> (f64, f64, f64) {
        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        unsafe {
            if GlobalMemoryStatusEx(&mut mem).is_ok() {
                let total_gb = (mem.ullTotalPhys as f64) / (1024.0 * 1024.0 * 1024.0);
                let avail_gb = (mem.ullAvailPhys as f64) / (1024.0 * 1024.0 * 1024.0);
                let used_gb = (total_gb - avail_gb).max(0.0);
                let percent = mem.dwMemoryLoad as f64;
                return (percent, used_gb, total_gb);
            }
        }
        (0.0, 0.0, 0.0)
    }

    // NVML Dynamic Wrapper for NVIDIA GPUs
    type NvmlReturn = i32;
    type NvmlDevice = *mut c_void;

    #[repr(C)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }

    pub struct Nvml {
        device: Option<NvmlDevice>,
        get_util: Option<unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> NvmlReturn>,
        get_temp: Option<unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn>,
        get_name: Option<unsafe extern "C" fn(NvmlDevice, *mut u8, u32) -> NvmlReturn>,
    }

    // Send/Sync safety for Nvml device pointer
    unsafe impl Send for Nvml {}
    unsafe impl Sync for Nvml {}

    impl Nvml {
        pub fn init() -> Self {
            unsafe {
                let lib_name = b"nvml.dll\0";
                let Ok(module) = LoadLibraryA(windows::core::PCSTR(lib_name.as_ptr())) else {
                    return Self { device: None, get_util: None, get_temp: None, get_name: None };
                };
                if module.is_invalid() {
                    return Self { device: None, get_util: None, get_temp: None, get_name: None };
                }

                let init_fn: Option<unsafe extern "C" fn() -> NvmlReturn> =
                    std::mem::transmute(GetProcAddress(module, windows::core::PCSTR(b"nvmlInit_v2\0".as_ptr())));
                let get_handle: Option<unsafe extern "C" fn(u32, *mut NvmlDevice) -> NvmlReturn> =
                    std::mem::transmute(GetProcAddress(module, windows::core::PCSTR(b"nvmlDeviceGetHandleByIndex_v2\0".as_ptr())));
                let get_util: Option<unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> NvmlReturn> =
                    std::mem::transmute(GetProcAddress(module, windows::core::PCSTR(b"nvmlDeviceGetUtilizationRates\0".as_ptr())));
                let get_temp: Option<unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn> =
                    std::mem::transmute(GetProcAddress(module, windows::core::PCSTR(b"nvmlDeviceGetTemperature\0".as_ptr())));
                let get_name: Option<unsafe extern "C" fn(NvmlDevice, *mut u8, u32) -> NvmlReturn> =
                    std::mem::transmute(GetProcAddress(module, windows::core::PCSTR(b"nvmlDeviceGetName\0".as_ptr())));

                if let (Some(init), Some(handle_fn)) = (init_fn, get_handle) {
                    if init() == 0 {
                        let mut dev: NvmlDevice = std::ptr::null_mut();
                        if handle_fn(0, &mut dev) == 0 && !dev.is_null() {
                            return Self {
                                device: Some(dev),
                                get_util,
                                get_temp,
                                get_name,
                            };
                        }
                    }
                }
                Self { device: None, get_util: None, get_temp: None, get_name: None }
            }
        }

        pub fn query(&self) -> (Option<f64>, Option<f64>, Option<String>) {
            let Some(dev) = self.device else { return (None, None, None) };
            let mut gpu_util = None;
            let mut gpu_temp = None;
            let mut gpu_name = None;

            unsafe {
                if let Some(util_fn) = self.get_util {
                    let mut util = NvmlUtilization { gpu: 0, memory: 0 };
                    if util_fn(dev, &mut util) == 0 {
                        gpu_util = Some(util.gpu as f64);
                    }
                }
                if let Some(temp_fn) = self.get_temp {
                    let mut temp: u32 = 0;
                    if temp_fn(dev, 0, &mut temp) == 0 {
                        gpu_temp = Some(temp as f64);
                    }
                }
                if let Some(name_fn) = self.get_name {
                    let mut buf = [0u8; 96];
                    if name_fn(dev, buf.as_mut_ptr(), buf.len() as u32) == 0 {
                        if let Ok(s) = std::ffi::CStr::from_ptr(buf.as_ptr() as *const i8).to_str() {
                            gpu_name = Some(s.to_string());
                        }
                    }
                }
            }
            (gpu_util, gpu_temp, gpu_name)
        }
    }

    pub fn get_bluetooth_devices() -> Vec<super::AccessoryDevice> {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$activeAudio = @(Get-PnpDevice -Class 'AudioEndpoint' | Where-Object { $_.Present -eq $true } | ForEach-Object { $_.FriendlyName })
$connectedBt = @()
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTaskDevs = $asTaskGen.MakeGenericMethod([Windows.Devices.Enumeration.DeviceInformationCollection])
  $selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelector()
  $op = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)
  $devices = ($asTaskDevs.Invoke($null, @($op))).GetAwaiter().GetResult()
  $asTaskDev = $asTaskGen.MakeGenericMethod([Windows.Devices.Bluetooth.BluetoothDevice])
  foreach ($d in $devices) {
    $devOp = [Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($d.Id)
    $bt = ($asTaskDev.Invoke($null, @($devOp))).GetAwaiter().GetResult()
    if ($bt -and $bt.ConnectionStatus -eq 1) {
      $connectedBt += $bt.Name.ToLower()
    }
  }
} catch {}

$devs = Get-PnpDevice -InstanceId "BTHENUM\{0000111e*" | Where-Object { $_.Status -eq "OK" }
$list = @()
foreach ($d in $devs) {
  $cleanName = ($d.FriendlyName -replace '\s+Hands-Free.*$', '').Trim()
  $cleanLower = $cleanName.ToLower()
  $isConnected = $false
  if ($connectedBt -contains $cleanLower) {
    $isConnected = $true
  } else {
    foreach ($a in $activeAudio) {
      if ($a.ToLower().Contains($cleanLower) -or $cleanLower.Contains($a.ToLower())) {
        $isConnected = $true
        break
      }
    }
  }
  if ($isConnected) {
    $p = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2").Data
    if ($p -ne $null) {
      $bat = [int]$p
      if ($bat -eq 90) { $bat = 100 }
      $isEarbuds = $cleanName -match '(?i)buds|airpods|earbuds|in-ear'
      $kind = if ($isEarbuds) { 'earbuds' } else { 'headphones' }
      $list += [PSCustomObject]@{ id = $d.InstanceId; name = $cleanName; battery = $bat; kind = $kind; connected = $true }
    }
  }
}
ConvertTo-Json -Compress @($list)
"#;
        let mut cmd = std::process::Command::new("powershell.exe");
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Ok(devices) = serde_json::from_slice::<Vec<super::AccessoryDevice>>(&output.stdout) {
                    return devices;
                }
            }
        }
        Vec::new()
    }
}

pub struct HardwareMonitor {
    latest: Mutex<SystemStats>,
    bluetooth: Mutex<Vec<AccessoryDevice>>,
}

impl HardwareMonitor {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            let (ram_usage, ram_used_gb, ram_total_gb) = win::get_ram();
            let initial = SystemStats {
                cpu_usage: 0.0,
                ram_usage: (ram_usage * 10.0).round() / 10.0,
                ram_used_gb: (ram_used_gb * 10.0).round() / 10.0,
                ram_total_gb: (ram_total_gb * 10.0).round() / 10.0,
                gpu_usage: None,
                gpu_temp: None,
                gpu_name: None,
            };
            Self {
                latest: Mutex::new(initial),
                bluetooth: Mutex::new(Vec::new()),
            }
        }
        #[cfg(not(windows))]
        Self {
            latest: Mutex::new(SystemStats::default()),
            bluetooth: Mutex::new(Vec::new()),
        }
    }

    pub fn get_latest(&self) -> SystemStats {
        self.latest.lock().unwrap().clone()
    }

    pub fn get_bluetooth(&self) -> Vec<AccessoryDevice> {
        self.bluetooth.lock().unwrap().clone()
    }
}

#[tauri::command]
pub fn get_system_stats(monitor: tauri::State<HardwareMonitor>) -> SystemStats {
    monitor.get_latest()
}

#[tauri::command]
pub fn get_bluetooth_devices(monitor: tauri::State<HardwareMonitor>) -> Vec<AccessoryDevice> {
    monitor.get_bluetooth()
}

pub fn start(app: AppHandle, gate: Arc<PollGate>, monitor: Arc<HardwareMonitor>) {
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut cpu = win::CpuTracker::new();
        #[cfg(windows)]
        let nvml = win::Nvml::init();
        #[cfg(windows)]
        let mut tick: u32 = 0;

        loop {
            gate.wait_until_active();

            while gate.is_active() {
                #[cfg(windows)]
                {
                    let cpu_usage = (cpu.get_usage() * 10.0).round() / 10.0;
                    let (ram_usage, ram_used_gb, ram_total_gb) = win::get_ram();
                    let (gpu_usage, gpu_temp, gpu_name) = nvml.query();

                    let stats = SystemStats {
                        cpu_usage,
                        ram_usage: (ram_usage * 10.0).round() / 10.0,
                        ram_used_gb: (ram_used_gb * 10.0).round() / 10.0,
                        ram_total_gb: (ram_total_gb * 10.0).round() / 10.0,
                        gpu_usage,
                        gpu_temp,
                        gpu_name,
                    };

                    *monitor.latest.lock().unwrap() = stats.clone();
                    let _ = app.emit_to(WINDOW_LABEL, "system-stats", stats.clone());
                    let _ = app.emit("system-stats", stats);

                    if tick % 15 == 0 {
                        let bt = win::get_bluetooth_devices();
                        *monitor.bluetooth.lock().unwrap() = bt.clone();
                        let _ = app.emit_to(WINDOW_LABEL, "bluetooth-devices", bt.clone());
                        let _ = app.emit("bluetooth-devices", bt);
                    }
                    tick = tick.wrapping_add(1);
                }

                #[cfg(not(windows))]
                {
                    let stats = SystemStats::default();
                    *monitor.latest.lock().unwrap() = stats.clone();
                    let _ = app.emit_to(WINDOW_LABEL, "system-stats", stats.clone());
                    let _ = app.emit("system-stats", stats);
                }

                std::thread::sleep(Duration::from_millis(1000));
            }
        }
    });
}
