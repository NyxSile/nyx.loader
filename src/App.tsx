import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "./nyx-theme.css";
import { AppleID } from "./AppleID";
import { Device, DeviceInfo } from "./Device";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  sideloadOperation,
  installSideStoreOperation,
  installLiveContainerOperation,
  Operation,
  OperationState,
  OperationUpdate,
} from "./components/operations";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LuZap, LuSparkles, LuPackage } from "react-icons/lu";
import OperationView from "./components/OperationView";
import { toast } from "sonner";
import { Modal } from "./components/Modal";
import { Certificates } from "./pages/Certificates";
import { AppIds } from "./pages/AppIds";
import { Settings } from "./pages/Settings";
import { Pairing } from "./pages/Pairing";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates } from "./update";
import { GlassCard } from "./components/GlassCard";
import { useTranslation } from "react-i18next";
import { usePlatform } from "./PlatformContext";
import { StarsBackground } from "./components/StarsBackground";
import { useStore } from "./StoreContext";

function App() {
  const { t } = useTranslation();
  const [simpleMode, setSimpleMode] = useStore<boolean>("simpleMode", false);

  const [operationState, setOperationState] = useState<OperationState | null>(
    null,
  );
  const [loggedInAs, setLoggedInAs] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [openModal, setOpenModal] = useState<
    null | "certificates" | "appids" | "pairing"
  >(null);
  const [version, setVersion] = useState<string>("");
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  const refreshDevicesRef = useRef<(() => void) | null>(null);

  const [noKeyringAvailable, setNoKeyringAvailable] = useState<boolean>(false);
  const { platform } = usePlatform();

  const checkKeyring = useCallback(async () => {
    try {
      let available = await invoke<boolean>("keyring_available");
      setNoKeyringAvailable(!available);
    } catch (e) {
      console.error("Unable to check keyring availability:", e);
      setNoKeyringAvailable(true);
    }
  }, []);

  useEffect(() => {
    checkKeyring();
  }, [checkKeyring]);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const ver = await getVersion();
        setVersion(ver.startsWith("n") ? ver : `n${ver}`);
      } catch {
        setVersion("n1.0.0");
      }
    };
    fetchVersion();
  }, []);

  useEffect(() => {
    try {
      checkForUpdates().catch(() => {});
    } catch {}
  }, []);

  const shortcutLabel = useCallback(
    (mac: string, windows: string, linux?: string) => {
      if (platform === "mac") return mac;
      if (platform === "linux") return linux ?? windows;
      return windows;
    },
    [platform],
  );

  const startOperation = useCallback(
    async (
      operation: Operation,
      params: { [key: string]: any },
    ): Promise<void> => {
      setOperationState({
        current: operation,
        started: [],
        failed: [],
        completed: [],
      });
      return new Promise<void>(async (resolve, reject) => {
        const unlistenFn = await listen<OperationUpdate>(
          "operation_" + operation.id,
          (event) => {
            setOperationState((old) => {
              if (old == null) return null;
              if (event.payload.updateType === "started") {
                return {
                  ...old,
                  started: [...old.started, event.payload.stepId],
                };
              } else if (event.payload.updateType === "finished") {
                return {
                  ...old,
                  completed: [...old.completed, event.payload.stepId],
                };
              } else if (event.payload.updateType === "failed") {
                return {
                  ...old,
                  failed: [
                    ...old.failed,
                    {
                      stepId: event.payload.stepId,
                      extraDetails: event.payload.extraDetails,
                    },
                  ],
                };
              }
              return old;
            });
          },
        );
        try {
          await invoke(operation.id + "_operation", params);
          unlistenFn();
          resolve();
        } catch (e) {
          unlistenFn();
          reject(e);
        }
      });
    },
    [setOperationState],
  );

  const ensuredLoggedIn = useCallback((): boolean => {
    if (loggedInAs) return true;
    toast.error(t("app.must_be_logged_in"));
    return false;
  }, [loggedInAs, t]);

  const ensureSelectedDevice = useCallback((): boolean => {
    if (selectedDevice) return true;
    toast.error(t("app.must_select_device"));
    return false;
  }, [selectedDevice, t]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === undefined) return;
      const key = event.key.toLowerCase();
      const primaryPressed = platform === "mac" ? event.metaKey : event.ctrlKey;
      if (!primaryPressed) return;

      if (!event.shiftKey && key === "p") {
        event.preventDefault();
        if (!ensureSelectedDevice()) return;
        setOpenModal("pairing");
      } else if (event.shiftKey && key === "c") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("certificates");
      } else if (event.shiftKey && key === "a") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("appids");
      } else if (!event.shiftKey && key === "r") {
        event.preventDefault();
        refreshDevicesRef.current?.();
      } else if (event.shiftKey && key === "s") {
        event.preventDefault();
        setSimpleMode((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [platform, ensureSelectedDevice, ensuredLoggedIn]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setIsDraggingOver(true);
          } else if (event.payload.type === "drop") {
            setIsDraggingOver(false);
            const paths = event.payload.paths;
            const ipa = paths.find((p) => p.toLowerCase().endsWith(".ipa"));
            if (ipa) {
              if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
              startOperation(sideloadOperation, {
                appPath: ipa,
              }).catch((e) => {
                console.error("Drag-and-drop sideload error:", e);
              });
            } else if (paths.length > 0) {
              toast.error(t("app.only_ipa_supported"));
            }
          } else {
            setIsDraggingOver(false);
          }
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {}

    return () => {
      if (unlisten) unlisten();
    };
  }, [ensuredLoggedIn, ensureSelectedDevice, startOperation, t]);

  return (
    <main
      className={`workspace ${simpleMode ? "simple-mode" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
      }}
    >
      {!simpleMode && <StarsBackground />}
      <header className="workspace-header">
        <div className="header-left">
          <div className="title-block">
            <img src="/nyx-loader.png" alt="nyx.loader" className="logo" />
            <div>
              <h1 className="title">
                nyx<span className="accent-dot">.</span>loader
              </h1>
              <p className="subtitle">nyx.sideload desktop companion</p>
            </div>
          </div>
          <span className="version-pill">
            {version || "n1.0.0"}
          </span>
        </div>
        <div className="header-actions">
          <button
            className={`toolbar-button simple-mode-btn ${simpleMode ? "active" : ""}`}
            onClick={() => setSimpleMode((prev) => !prev)}
            title={t("settings.simple_mode_desc")}
          >
            {simpleMode ? (
              <>
                <LuZap size={13} className="toolbar-btn-icon" /> Simple: ON
              </>
            ) : (
              <>
                <LuSparkles size={13} className="toolbar-btn-icon" /> Stars: ON
              </>
            )}
          </button>
          <button
            className="toolbar-button"
            onClick={async () => {
              try {
                await openUrl("https://nyx.sideload.space");
              } catch (error) {
                console.error("Failed to open nyx.sideload.space link", error);
              }
            }}
          >
            nyx.sideload.space
          </button>
          <button
            className="toolbar-button"
            onClick={async () => {
              try {
                await openUrl("https://nyxsile.lol");
              } catch (error) {
                console.error("Failed to open nyxsile.lol link", error);
              }
            }}
          >
            nyxsile.lol
          </button>
        </div>
      </header>
      <div className="workspace-body">
        <aside className="workspace-sidebar">
          <section className="workspace-section">
            <div className="section-header">
              <p className="section-label">{t("app.section_account")}</p>
            </div>
            <GlassCard className="panel">
              <AppleID
                loggedInAs={loggedInAs}
                setLoggedInAs={setLoggedInAs}
                noKeyringAvailable={noKeyringAvailable}
              />
            </GlassCard>
          </section>
          <section className="workspace-section">
            <p className="section-label">{t("app.section_management")}</p>
            <div className="workspace-list">
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensureSelectedDevice()) return;
                  setOpenModal("pairing");
                }}
              >
                {t("app.manage_pairing_file")}{" "}
                <span aria-hidden="true">{shortcutLabel("⌘P", "Ctrl+P")}</span>
              </button>
              <button
                className="workspace-list-item"
                onClick={() => {
                  refreshDevicesRef.current?.();
                }}
              >
                {t("app.refresh_devices")}{" "}
                <span aria-hidden="true">{shortcutLabel("⌘R", "Ctrl+R")}</span>
              </button>
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensuredLoggedIn()) return;
                  setOpenModal("certificates");
                }}
              >
                {t("app.certificates")}{" "}
                <span aria-hidden="true">
                  {shortcutLabel("⌘⇧C", "Ctrl+Shift+C")}
                </span>
              </button>
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensuredLoggedIn()) return;
                  setOpenModal("appids");
                }}
              >
                {t("app.app_ids")}{" "}
                <span aria-hidden="true">
                  {shortcutLabel("⌘⇧A", "Ctrl+Shift+A")}
                </span>
              </button>
            </div>
          </section>
        </aside>
        <section className="workspace-content">
          <section className="workspace-section">
            <div className="section-header">
              <p className="section-label">{t("app.devices")}</p>
              <span className="section-hint">
                {selectedDevice
                  ? t("app.active_device", {
                      name: `${selectedDevice.name} (${selectedDevice.version})`,
                    })
                  : t("app.select_device")}
              </span>
            </div>
            <GlassCard className="panel">
              <Device
                selectedDevice={selectedDevice}
                setSelectedDevice={setSelectedDevice}
                registerRefresh={(fn) => {
                  refreshDevicesRef.current = fn ?? null;
                }}
              />
            </GlassCard>
          </section>
          <section className="workspace-section">
            <div className="section-header">
              <p className="section-label">{t("app.installers")}</p>
              <span className="section-hint">{t("app.choose_build")}</span>
            </div>
            <GlassCard className="panel">
              <div className="action-row single-row">
                <button
                  onClick={() => {
                    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
                    startOperation(installSideStoreOperation, {
                      nightly: false,
                      liveContainer: false,
                    }).catch((e) => {
                      console.log(e.type);
                      console.error(e.message);
                    });
                  }}
                >
                  {t("app.sidestore_stable")}
                </button>
                <button
                  onClick={() => {
                    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
                    startOperation(installSideStoreOperation, {
                      nightly: true,
                      liveContainer: false,
                    }).catch((e) => {
                      console.log(e.type);
                      console.error(e.message);
                    });
                  }}
                >
                  {t("app.sidestore_nightly")}
                </button>
                <button
                  onClick={() => {
                    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
                    startOperation(installLiveContainerOperation, {
                      nightly: false,
                      liveContainer: true,
                    }).catch((e) => {
                      console.log(e.type);
                      console.error(e.message);
                    });
                  }}
                >
                  {t("app.livecontainer_sidestore_stable")}
                </button>
                <button
                  onClick={() => {
                    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
                    startOperation(installLiveContainerOperation, {
                      nightly: true,
                      liveContainer: true,
                    }).catch((e) => {
                      console.log(e.type);
                      console.error(e.message);
                    });
                  }}
                >
                  {t("app.livecontainer_sidestore_nightly")}
                </button>
                <button
                  onClick={async () => {
                    if (!ensuredLoggedIn() || !ensureSelectedDevice()) return;
                    let path = await openFileDialog({
                      multiple: false,
                      filters: [
                        { name: t("app.ipa_files"), extensions: ["ipa"] },
                      ],
                    });
                    if (!path) return;
                    startOperation(sideloadOperation, {
                      appPath: path as string,
                    }).catch((e) => {
                      console.log(e.type);
                      console.error(e.message);
                    });
                  }}
                >
                  {t("app.import_ipa")}
                </button>
              </div>
            </GlassCard>
          </section>
          <section className="workspace-section">
            <p className="section-label">{t("app.settings")}</p>
            <GlassCard className="panel settings-panel">
              <Settings
                ensureSelectedDevice={ensureSelectedDevice}
                setSelectedDevice={setSelectedDevice}
                platform={platform}
                shortcutLabel={shortcutLabel}
                checkKeyring={checkKeyring}
              />
            </GlassCard>
          </section>
          {operationState && (
            <OperationView
              operationState={operationState}
              closeMenu={() => setOperationState(null)}
            />
          )}
        </section>
      </div>
      <Modal
        isOpen={openModal === "certificates"}
        close={() => setOpenModal(null)}
      >
        <Certificates />
      </Modal>
      <Modal isOpen={openModal === "appids"} close={() => setOpenModal(null)}>
        <AppIds />
      </Modal>
      <Modal isOpen={openModal === "pairing"} close={() => setOpenModal(null)}>
        <Pairing />
      </Modal>
      {isDraggingOver && (
        <div className="drag-drop-overlay">
          <div className="drag-drop-modal">
            <div className="drag-drop-icon">
              <LuPackage size={44} color="#7b61ff" />
            </div>
            <h3>{t("app.drop_ipa_title")}</h3>
            <p>
              {t("app.drop_ipa_desc", {
                device: selectedDevice ? selectedDevice.name : "iPhone",
              })}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
