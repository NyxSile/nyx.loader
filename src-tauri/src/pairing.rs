use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

// used https://github.com/jkcoxson/idevice_pair/ as a guide
use idevice::{
    IdeviceError, IdeviceService, RemoteXpcClient,
    core_device_proxy::CoreDeviceProxy,
    house_arrest::HouseArrestClient,
    installation_proxy::InstallationProxyClient,
    lockdown::LockdownClient,
    provider::IdeviceProvider,
    remote_pairing::{RemotePairingClient, RpPairingFile},
    rsd::RsdHandshake,
    usbmuxd::UsbmuxdConnection,
};
use isideload::util::storage::{InMemoryStorage, SideloadingStorage};
use plist_macro::{plist, plist_to_xml_bytes};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::{
    device::{DeviceInfo, DeviceInfoMutex, get_provider},
    error::AppError,
    secure_storage::{create_sideloading_storage, keyring_available},
};

struct PairingStorageEntry {
    keyring_enabled: bool,
    storage: Box<dyn SideloadingStorage>,
}

static PAIRING_STORAGE: OnceLock<Mutex<PairingStorageEntry>> = OnceLock::new();

const PAIRING_APPS: &[(&str, &str)] = &[
    ("SideStore", "ALTPairingFile.mobiledevicepairing"),
    (
        "LiveContainer",
        "SideStore/Documents/ALTPairingFile.mobiledevicepairing",
    ),
    ("Feather", "pairingFile.plist"),
    ("StikDebug", "pairingFile.plist"),
    ("StikDebug (Sideloaded)", "rp_pairing_file.plist"),
    ("StikTest", "stiktest_pairing.plist"),
    ("Protokolle", "pairingFile.plist"),
    ("Antrag", "pairingFile.plist"),
    ("SparseBox", "pairingFile.plist"),
    ("StikStore", "pairingFile.plist"),
    ("ByeTunes", "pairing file/pairingFile.plist"),
    ("Reynard", "pairingFile.plist"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingAppInfo {
    pub name: String,
    pub bundle_id: String,
    pub path: String,
}

async fn generate_lockdown_plist(
    device: &DeviceInfo,
    provider: &dyn IdeviceProvider,
    usbmuxd: &mut UsbmuxdConnection,
) -> Result<plist::Value, AppError> {
    let mut pairing_file = usbmuxd.get_pair_record(&device.udid).await.map_err(|e| {
        AppError::LockdownPairing(
            "Failed to get pairing record for device".into(),
            e.to_string(),
        )
    })?;

    pairing_file.udid = Some(device.udid.clone());

    let mut lc = LockdownClient::connect(provider).await.map_err(|e| {
        AppError::DeviceComsWithMessage("Failed to connect to lockdown".into(), e.to_string())
    })?;

    lc.start_session(&pairing_file).await.map_err(|e| {
        AppError::DeviceComsWithMessage("Failed to start lockdown session".into(), e.to_string())
    })?;

    lc.set_value(
        "EnableWifiDebugging",
        true.into(),
        Some("com.apple.mobile.wireless_lockdown"),
    )
    .await
    .map_err(|e| {
        AppError::LockdownPairing("Failed to enable wifi debugging".into(), e.to_string())
    })?;

    plist::Value::from_reader_xml(std::io::Cursor::new(pairing_file.serialize().map_err(
        |e| AppError::LockdownPairing("Failed to serialize pairing file".into(), e.to_string()),
    )?))
    .map_err(|e| {
        AppError::LockdownPairing(
            "Failed to parse pairing file as plist".into(),
            e.to_string(),
        )
    })
}

async fn generate_rppairing_plist(
    provider: &dyn IdeviceProvider,
) -> Result<(plist::Value, Vec<u8>), IdeviceError> {
    let bytes = generate_rppairing(provider, "iloader").await?.to_bytes();
    let plist = plist::Value::from_reader_xml(std::io::Cursor::new(&bytes))
        .map_err(|e| IdeviceError::InternalError(format!("Invalid RPPairing plist: {}", e)))?;
    Ok((plist, bytes))
}

async fn generate_rppairing(
    provider: &dyn IdeviceProvider,
    hostname: &str,
) -> Result<RpPairingFile, IdeviceError> {
    info!("Connecting to CoreDeviceProxy...");
    let proxy = CoreDeviceProxy::connect(provider).await?;
    let rsd_port = proxy.tunnel_info().server_rsd_port;
    info!("CDTunnel established, RSD port {rsd_port}");

    info!("Starting TCP stack...");
    let adapter = proxy.create_software_tunnel()?;
    let mut adapter = adapter.to_async_handle();

    info!("Performing RSD handshake...");
    let rsd_stream = adapter.connect(rsd_port).await?;
    let handshake = RsdHandshake::new(rsd_stream).await?;
    info!("RSD: {} services", handshake.services.len());
    let tunnel_service = handshake
        .services
        .get("com.apple.internal.dt.coredevice.untrusted.tunnelservice")
        .ok_or_else(|| IdeviceError::InternalError("Untrusted tunnel service not found".into()))?;

    info!("Connecting to untrusted tunnel service...");
    let tunnel_service_stream = adapter.connect(tunnel_service.port).await?;
    let mut remote_xpc = RemoteXpcClient::new(tunnel_service_stream).await?;
    remote_xpc.do_handshake().await?;
    let _ = remote_xpc.recv_root().await;

    info!("Starting RPPairing...");
    info!("(You may need to tap Trust on the device)");
    let mut pairing_file = RpPairingFile::generate(hostname);
    let mut pairing_client = RemotePairingClient::new(remote_xpc, hostname);
    pairing_client
        .connect(&mut pairing_file, async || "000000".to_string())
        .await?;

    // use it right away to try and convince the device to commmit it to the keychain
    info!("Connecting to untrusted tunnel service again...");
    let tunnel_service_stream = adapter.connect(tunnel_service.port).await?;
    let mut remote_xpc = RemoteXpcClient::new(tunnel_service_stream).await?;
    remote_xpc.do_handshake().await?;
    let _ = remote_xpc.recv_root().await;
    let mut pairing_client = RemotePairingClient::new(remote_xpc, hostname);
    pairing_client
        .connect(&mut pairing_file, async || "000000".to_string())
        .await?;

    Ok(pairing_file)
}

async fn write_single_file(
    afc_client: &mut idevice::afc::AfcClient,
    full_path: &str,
    data: &[u8],
) -> Result<(), AppError> {
    if let Some((parent, _)) = full_path.rsplit_once('/') {
        if !parent.is_empty() {
            let _ = afc_client.mk_dir(parent.to_string()).await;
        }
    }

    let mut file = afc_client
        .open(
            full_path.to_string(),
            idevice::afc::opcode::AfcFopenMode::Wr,
        )
        .await
        .map_err(|e| {
            AppError::HouseArrest(format!("Failed to open {} on device", full_path), e.to_string())
        })?;

    file.write_entire(data)
        .await
        .map_err(|e| AppError::HouseArrest(format!("Failed to write {}", full_path), e.to_string()))?;
    file.close()
        .await
        .map_err(|e| AppError::HouseArrest(format!("Failed to close {}", full_path), e.to_string()))?;

    Ok(())
}

pub async fn place_file(
    pairing: Vec<u8>,
    provider: &dyn IdeviceProvider,
    bundle_id: String,
    path: String,
) -> Result<(), AppError> {
    let house_arrest_client = HouseArrestClient::connect(provider).await.map_err(|e| {
        AppError::HouseArrest("Failed to connect to house arrest".into(), e.to_string())
    })?;

    let mut afc_client = house_arrest_client
        .vend_documents(bundle_id)
        .await
        .map_err(|e| AppError::HouseArrest("Failed to vend documents".into(), e.to_string()))?;

    // 1. Primary path requested by application
    let target_path = format!("/Documents/{}", path.trim_start_matches('/'));
    write_single_file(&mut afc_client, &target_path, &pairing).await?;

    // 2. Also ensure standard files exist directly in root /Documents so they are visible
    // and accessible in the iOS Files app ("На моем iPhone")
    let alt_path = "/Documents/ALTPairingFile.mobiledevicepairing";
    if target_path != alt_path {
        let _ = write_single_file(&mut afc_client, alt_path, &pairing).await;
    }

    let plist_path = "/Documents/pairingFile.plist";
    if target_path != plist_path {
        let _ = write_single_file(&mut afc_client, plist_path, &pairing).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn place_pairing_cmd(
    device_state: State<'_, DeviceInfoMutex>,
    bundle_id: String,
    path: String,
) -> Result<(), AppError> {
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    let provider = get_provider(&device.info).await?;

    place_file(device.pairing, &provider, bundle_id, path).await
}

#[tauri::command]
pub async fn save_pairing_to_device_cmd(
    device_state: State<'_, DeviceInfoMutex>,
) -> Result<Vec<String>, AppError> {
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    let provider = get_provider(&device.info).await?;
    let mut installation_proxy =
        InstallationProxyClient::connect(&provider)
            .await
            .map_err(|e| {
                AppError::DeviceComsWithMessage(
                    "Failed to connect to installation proxy".into(),
                    e.to_string(),
                )
            })?;

    let installed_apps = installation_proxy
        .get_apps(Some("User"), None)
        .await
        .map_err(|e| {
            AppError::DeviceComsWithMessage("Failed to get installed apps".into(), e.to_string())
        })?;

    let mut targets: Vec<(String, String, String)> = Vec::new();

    for (bundle_id, app) in &installed_apps {
        let name = app
            .as_dictionary()
            .and_then(|x| x.get("CFBundleDisplayName").or_else(|| x.get("CFBundleName")))
            .and_then(|x| x.as_string())
            .unwrap_or(bundle_id);

        if let Some((_, path)) = PAIRING_APPS.iter().find(|(n, _)| *n == name) {
            targets.push((name.to_string(), bundle_id.clone(), path.to_string()));
        } else if let Some(file_sharing) = app
            .as_dictionary()
            .and_then(|x| x.get("UIFileSharingEnabled"))
            .and_then(|x| x.as_boolean())
        {
            if file_sharing {
                targets.push((
                    name.to_string(),
                    bundle_id.clone(),
                    "ALTPairingFile.mobiledevicepairing".to_string(),
                ));
            }
        }
    }

    if targets.is_empty() {
        return Err(AppError::HouseArrest(
            "No compatible apps found on device".into(),
            "Install SideStore, LiveContainer, Feather, or any app with File Sharing enabled".into(),
        ));
    }

    let mut saved_apps = Vec::new();
    for (name, bundle_id, path) in targets {
        if place_file(device.pairing.clone(), &provider, bundle_id, path).await.is_ok() {
            saved_apps.push(name);
        }
    }

    if saved_apps.is_empty() {
        return Err(AppError::HouseArrest(
            "Failed to save pairing file to device".into(),
            "Could not access app Documents directory".into(),
        ));
    }

    Ok(saved_apps)
}

pub async fn auto_sync_pairing_to_device(
    provider: &dyn IdeviceProvider,
    pairing: &[u8],
) -> Result<usize, AppError> {
    let mut installation_proxy = match InstallationProxyClient::connect(provider).await {
        Ok(client) => client,
        Err(_) => return Ok(0),
    };

    let installed_apps = match installation_proxy.get_apps(Some("User"), None).await {
        Ok(apps) => apps,
        Err(_) => return Ok(0),
    };

    let mut count = 0;
    for (bundle_id, app) in &installed_apps {
        let name = app
            .as_dictionary()
            .and_then(|x| x.get("CFBundleDisplayName").or_else(|| x.get("CFBundleName")))
            .and_then(|x| x.as_string())
            .unwrap_or(bundle_id);

        if let Some((_, path)) = PAIRING_APPS.iter().find(|(n, _)| *n == name) {
            if place_file(pairing.to_vec(), provider, bundle_id.clone(), path.to_string()).await.is_ok() {
                count += 1;
            }
        }
    }

    if count > 0 {
        info!("Auto-synced pairing file to {} apps on connected device", count);
    }
    Ok(count)
}

// prompt for a location to save the pairing file, then export it there. This is for advanced users who want to use the pairing file with other tools, or just want a backup of it. Normal users should use the "Place" button next to the app they want to pair with instead, which will transfer the pairing file automatically.
#[tauri::command]
pub async fn export_pairing_cmd(
    device_state: State<'_, DeviceInfoMutex>,
    app: AppHandle,
) -> Result<(), AppError> {
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    let save_path = app
        .dialog()
        .file()
        .add_filter("Pairing File", &["plist", "mobiledevicepairing"])
        .set_file_name("pairingFile.plist")
        .set_title("Export Pairing File")
        .blocking_save_file();

    if let Some(save_path) = save_path
        && let Some(save_path) = save_path.as_path()
    {
        tokio::fs::write(save_path, &device.pairing)
            .await
            .map_err(|e| {
                AppError::Filesystem("Failed to write pairing file".into(), e.to_string())
            })?;

        Ok(())
    } else {
        Err(AppError::Canceled("Export".into()))
    }
}

fn build_pairing_storage_entry(app: &AppHandle, keyring_enabled: bool) -> PairingStorageEntry {
    let storage = create_sideloading_storage(app).unwrap_or_else(|e| {
        error!(
            "Failed to create sideloading storage, storing pairing file in memory: {}",
            e
        );
        Box::new(InMemoryStorage::new())
    });

    PairingStorageEntry {
        keyring_enabled,
        storage,
    }
}

fn with_pairing_storage<T>(
    app: &AppHandle,
    f: impl FnOnce(&dyn SideloadingStorage) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let current_keyring_enabled = keyring_available();
    let storage = PAIRING_STORAGE
        .get_or_init(|| Mutex::new(build_pairing_storage_entry(app, current_keyring_enabled)));

    let mut guard = storage
        .lock()
        .map_err(|_| AppError::Misc("Failed to lock pairing storage".to_string()))?;

    if guard.keyring_enabled != current_keyring_enabled {
        info!(
            "Pairing storage backend changed at runtime (keyring_enabled: {} -> {}), recreating storage",
            guard.keyring_enabled, current_keyring_enabled
        );
        *guard = build_pairing_storage_entry(app, current_keyring_enabled);
    }

    f(guard.storage.as_ref())
}

pub async fn pairing_file(
    app: &AppHandle,
    device: &DeviceInfo,
    usbmuxd: &mut UsbmuxdConnection,
    cancel: CancellationToken,
) -> Result<Vec<u8>, AppError> {
    let provider = get_provider(device).await?;

    let lockdown_plist = tokio::select! {
        _ = cancel.cancelled() => {
            return Err(AppError::Canceled("Pairing".into()));
        }
        res = generate_lockdown_plist(device, &provider, usbmuxd) => res?
    };

    // rppairing is 17.4+
    if is_ios_version_below(device.version.as_str(), 17, 4) {
        let lockdown_dict = lockdown_plist.as_dictionary().cloned().ok_or_else(|| {
            AppError::LockdownPairing(
                "Lockdown plist was not a dictionary".into(),
                "Invalid lockdown plist".into(),
            )
        })?;
        return Ok(plist_to_xml_bytes(&lockdown_dict));
    }

    let cache_key = format!("rppairing_file_{}", device.udid);

    let cached_rppairing = with_pairing_storage(app, |storage| {
        storage.retrieve_data(&cache_key).map_err(|e| {
            AppError::Storage("Failed to get RPPairing from storage".into(), e.to_string())
        })
    })?;

    let rppairing_plist = if let Some(cached) = cached_rppairing {
        match plist::Value::from_reader_xml(std::io::Cursor::new(&cached)) {
            Ok(plist) => plist,
            Err(e) => {
                warn!(
                    "Cached RPPairing is invalid for device {}, regenerating: {}",
                    device.name, e
                );

                let (generated_plist, generated_bytes) = tokio::select! {
                    _ = cancel.cancelled() => {
                        return Err(AppError::Canceled("Pairing".into()));
                    }
                    res = generate_rppairing_plist(&provider) => {
                        res.map_err(|e| AppError::RemotePairing(e.to_string()))?
                    }
                };

                with_pairing_storage(app, |storage| {
                    storage
                        .store_data(&cache_key, &generated_bytes)
                        .map_err(|e| {
                            AppError::Storage("Failed to store RPPairing".into(), e.to_string())
                        })
                })?;

                generated_plist
            }
        }
    } else {
        info!("Generating new RPPairing for device {}", device.name);

        let (generated_plist, generated_bytes) = tokio::select! {
            _ = cancel.cancelled() => {
                return Err(AppError::Canceled("Pairing".into()));
            }
            res = generate_rppairing_plist(&provider) => {
                res.map_err(|e| AppError::RemotePairing(e.to_string()))?
            }
        };

        with_pairing_storage(app, |storage| {
            storage
                .store_data(&cache_key, &generated_bytes)
                .map_err(|e| AppError::Storage("Failed to store RPPairing".into(), e.to_string()))
        })?;

        generated_plist
    };

    if cancel.is_cancelled() {
        return Err(AppError::Canceled("Pairing".into()));
    }

    let pairing_plist = plist!(dict {
        :< lockdown_plist,
        :< rppairing_plist,
    });

    Ok(plist_to_xml_bytes(&pairing_plist))
}

#[tauri::command]
pub async fn delete_stored_rppairing(
    device_state: State<'_, DeviceInfoMutex>,
    app: AppHandle,
) -> Result<(), AppError> {
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };

    let cache_key = format!("rppairing_file_{}", device.info.udid);

    with_pairing_storage(&app, |storage| {
        storage.delete(&cache_key).map_err(|e| {
            AppError::Storage("Failed to delete stored RPPairing".into(), e.to_string())
        })
    })?;

    Ok(())
}

#[tauri::command]
pub async fn has_stored_rppairing(device: DeviceInfo, app: AppHandle) -> Result<bool, AppError> {
    // rppairing not supported <17.4, returning true so the frontend can still automatically select it
    if is_ios_version_below(&device.version, 17, 4) {
        return Ok(true);
    }
    let cache_key = format!("rppairing_file_{}", device.udid);

    with_pairing_storage(&app, |storage| {
        storage.retrieve_data(&cache_key).map_err(|e| {
            AppError::Storage("Failed to retrieve stored RPPairing".into(), e.to_string())
        })
    })
    .map(|opt| opt.is_some())
}

#[tauri::command]
pub async fn installed_pairing_apps(
    device_state: State<'_, DeviceInfoMutex>,
) -> Result<Vec<PairingAppInfo>, AppError> {
    let device = {
        let device_guard = device_state.lock().unwrap();
        match &*device_guard {
            Some(d) => d.clone(),
            None => return Err(AppError::NoDeviceSelected),
        }
    };
    let provider = get_provider(&device.info).await?;
    let mut installation_proxy =
        InstallationProxyClient::connect(&provider)
            .await
            .map_err(|e| {
                AppError::DeviceComsWithMessage(
                    "Failed to connect to installation proxy".into(),
                    e.to_string(),
                )
            })?;

    let installed_apps = installation_proxy
        .get_apps(Some("User"), None)
        .await
        .map_err(|e| {
            AppError::DeviceComsWithMessage("Failed to get installed apps".into(), e.to_string())
        })?;

    let mut installed = HashMap::new();
    for (bundle_id, app) in installed_apps {
        let n = app
            .as_dictionary()
            .and_then(|x| x.get("CFBundleDisplayName").and_then(|x| x.as_string()))
            .ok_or(AppError::Misc("Failed to parse installed apps".to_string()))?;

        if PAIRING_APPS.iter().any(|(name, _)| name == &n) {
            if bundle_id.contains("com.stik.stikdebug") {
                installed.insert(format!("{} (Sideloaded)", n), bundle_id);
            } else {
                installed.insert(n.to_string(), bundle_id);
            }
        }
    }

    let mut result = Vec::new();
    for (name, path) in PAIRING_APPS {
        if let Some(bundle_id) = installed.get(*name) {
            result.push(PairingAppInfo {
                name: name.to_string(),
                bundle_id: bundle_id.to_string(),
                path: path.to_string(),
            });
        }
    }
    Ok(result)
}

pub async fn get_sidestore_info(
    device: &DeviceInfo,
    live_container: bool,
) -> Result<Option<PairingAppInfo>, AppError> {
    let provider = get_provider(device).await?;
    let mut installation_proxy =
        InstallationProxyClient::connect(&provider)
            .await
            .map_err(|e| {
                AppError::DeviceComsWithMessage(
                    "Failed to connect to installation proxy".into(),
                    e.to_string(),
                )
            })?;

    let installed_apps = installation_proxy
        .get_apps(Some("User"), None)
        .await
        .map_err(|e| {
            AppError::DeviceComsWithMessage("Failed to get installed apps".into(), e.to_string())
        })?;

    for (bundle_id, app) in installed_apps {
        let n = app
            .as_dictionary()
            .and_then(|x| x.get("CFBundleDisplayName").and_then(|x| x.as_string()))
            .ok_or(AppError::Misc("Failed to parse installed apps".to_string()))?;

        if n == "SideStore" || (live_container && n == "LiveContainer") {
            return Ok(Some(PairingAppInfo {
                name: n.to_string(),
                bundle_id: bundle_id.to_string(),
                path: PAIRING_APPS
                    .iter()
                    .find(|(name, _)| name == &n)
                    .map(|(_, path)| path.to_string())
                    .unwrap_or_default(),
            }));
        }
    }

    Ok(None)
}

fn parse_version_component(segment: Option<&str>) -> u32 {
    segment
        .and_then(|s| {
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                None
            } else {
                digits.parse().ok()
            }
        })
        .unwrap_or(0)
}

fn is_ios_version_below(version: &str, target_major: u32, target_minor: u32) -> bool {
    let mut parts = version.split('.');
    let major = parse_version_component(parts.next());
    let minor = parse_version_component(parts.next());
    (major, minor) < (target_major, target_minor)
}
