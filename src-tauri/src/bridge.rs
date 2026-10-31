//! Line-delimited JSON bridge used only by the Electron main process.
use crate::{GameState, InstallState, multiplayer::MultiplayerState};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    any::Any,
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
pub type State<'a, T> = &'a T;
#[derive(Clone, Default)]
pub struct AppHandle(Arc<AppState>);
#[derive(Default)]
struct AppState {
    install: InstallState,
    game: GameState,
    multiplayer: MultiplayerState,
}
impl AppHandle {
    pub fn emit<T: Serialize>(&self, event: &str, payload: T) -> Result<(), String> {
        send(json!({"event": event, "payload": payload}));
        Ok(())
    }
    pub fn state<T: 'static>(&self) -> &T {
        let values: [&dyn Any; 3] = [&self.0.install, &self.0.game, &self.0.multiplayer];
        values
            .into_iter()
            .find_map(|v| v.downcast_ref())
            .expect("unknown state")
    }
    pub fn path(&self) -> Paths {
        Paths
    }
}
pub struct Paths;
impl Paths {
    pub fn home_dir(&self) -> Result<PathBuf, String> {
        env_path("OSML_HOME")
    }
    pub fn app_config_dir(&self) -> Result<PathBuf, String> {
        env_path("OSML_CONFIG")
    }
    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        env_path("OSML_CONFIG")
    }
    pub fn resource_dir(&self) -> Result<PathBuf, String> {
        env_path("OSML_RESOURCES")
    }
}
fn env_path(name: &str) -> Result<PathBuf, String> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is not set"))
}
static OUTPUT: Mutex<()> = Mutex::new(());
fn send(value: Value) {
    let _guard = OUTPUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
}
fn argument<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Invalid argument {name}: {e}"))
}
fn to_value<T: Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}
async fn dispatch(app: AppHandle, command: &str, args: Value) -> Result<Value, String> {
    match command {
        "set_download_preference" => to_value(crate::set_download_preference(
            argument(&args, "source")?,
            argument(&args, "customUrl")?,
            argument(&args, "threads")?,
        )),
        "probe_download_sources" => {
            to_value(crate::probe_download_sources(argument(&args, "customUrl")?).await)
        }
        "get_version_manifest" => to_value(
            crate::get_version_manifest(argument(&args, "root")?, argument(&args, "force")?)
                .await?,
        ),
        "get_betacraft_manifest" => to_value(
            crate::get_betacraft_manifest(argument(&args, "root")?, argument(&args, "force")?)
                .await?,
        ),
        "get_installed_versions" => {
            to_value(crate::get_installed_versions(argument(&args, "root")?)?)
        }
        "read_skin_as_data_url" => {
            to_value(crate::read_skin_as_data_url(argument(&args, "path")?).await?)
        }
        "read_home_page_file" => {
            to_value(crate::read_home_page_file(argument(&args, "path")?).await?)
        }
        "fetch_home_page" => to_value(crate::fetch_home_page(argument(&args, "url")?).await?),
        "search_content" => to_value(
            crate::search_content(
                argument(&args, "query")?,
                argument(&args, "projectType")?,
                argument(&args, "gameVersion")?,
                argument(&args, "loader")?,
                argument(&args, "sort")?,
                argument(&args, "offset")?,
                argument(&args, "limit")?,
            )
            .await?,
        ),
        "get_content_versions" => to_value(
            crate::get_content_versions(
                argument(&args, "projectIdOrSlug")?,
                argument(&args, "gameVersion")?,
                argument(&args, "loader")?,
            )
            .await?,
        ),
        "download_content_file" => {
            to_value(crate::download_content_file(argument(&args, "request")?).await?)
        }
        "get_version_loaders" => {
            to_value(crate::get_version_loaders(argument(&args, "mcVersion")?).await?)
        }
        "install_version" => to_value(
            crate::install_version(
                app.clone(),
                app.state::<InstallState>(),
                argument(&args, "request")?,
            )
            .await?,
        ),
        "detect_java" => to_value(crate::detect_java(argument(&args, "root")?)),
        "get_system_info" => to_value(crate::get_system_info(
            app.clone(),
            app.state::<GameState>(),
        )?),
        "launch_game" => to_value(
            crate::launch_game(
                app.clone(),
                app.state::<GameState>(),
                argument(&args, "request")?,
            )
            .await?,
        ),
        "stop_game" => to_value(crate::stop_game(app.state::<GameState>())?),
        "get_bedrock_status" => to_value(crate::get_bedrock_status(
            app.clone(),
            argument(&args, "root")?,
        )?),
        "get_bedrock_versions" => {
            to_value(crate::get_bedrock_versions(argument(&args, "apiSource")?).await)
        }
        "get_bedrock_content" => {
            to_value(crate::get_bedrock_content(argument(&args, "category")?).await)
        }
        "install_bedrock_version" => to_value(
            crate::install_bedrock_version(
                app.clone(),
                app.state::<InstallState>(),
                argument(&args, "versionId")?,
                argument(&args, "downloadUrl")?,
                argument(&args, "root")?,
                argument(&args, "apiSource")?,
                argument(&args, "threads")?,
            )
            .await?,
        ),
        "cancel_install" => {
            to_value(crate::cancel_install(app.clone(), app.state::<InstallState>()).await?)
        }
        "install_bedrock_pack" => to_value(
            crate::install_bedrock_pack(
                app.clone(),
                argument(&args, "source")?,
                argument(&args, "filename")?,
                argument(&args, "root")?,
            )
            .await?,
        ),
        "launch_bedrock" => to_value(crate::launch_bedrock(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "root")?,
            argument(&args, "offlineAccount")?,
        )?),
        "get_bedrock_runtime_status" => {
            to_value(crate::get_bedrock_runtime_status(argument(&args, "force")?))
        }
        "auto_provision_bedrock_runtime" => {
            to_value(crate::auto_provision_bedrock_runtime(app.clone()))
        }
        "check_bedrockboot_dependencies" => to_value(crate::check_bedrockboot_dependencies(
            argument(&args, "force")?,
        )),
        "auto_fix_bedrockboot_dependencies" => {
            to_value(crate::auto_fix_bedrockboot_dependencies(app.clone()))
        }
        "enable_bedrock_developer_mode" => to_value(crate::enable_bedrock_developer_mode()?),
        "auto_install_bds_fallback" => to_value(
            crate::auto_install_bds_fallback(
                app.clone(),
                argument(&args, "versionId")?,
                argument(&args, "root")?,
            )
            .await?,
        ),
        "open_folder" => to_value(crate::open_folder(app.clone(), argument(&args, "path")?)?),
        "resolve_mcmod_entry" => to_value(
            crate::resolve_mcmod_entry(
                argument(&args, "title")?,
                argument(&args, "slug")?,
                argument(&args, "projectType")?,
            )
            .await?,
        ),
        "open_url" => to_value(crate::open_url(app.clone(), argument(&args, "url")?)?),
        "delete_version" => to_value(
            crate::delete_version(
                app.clone(),
                argument(&args, "versionId")?,
                argument(&args, "root")?,
            )
            .await?,
        ),
        "delete_bedrock_version" => to_value(
            crate::delete_bedrock_version(
                app.clone(),
                argument(&args, "versionId")?,
                argument(&args, "root")?,
            )
            .await?,
        ),
        "clean_download_cache" => {
            to_value(crate::clean_download_cache(app.clone(), argument(&args, "root")?).await?)
        }
        "get_bedrock_loaders" => {
            to_value(crate::get_bedrock_loaders(argument(&args, "mcVersion")?).await?)
        }
        "install_bedrock_loader" => to_value(
            crate::install_bedrock_loader(
                app.clone(),
                argument(&args, "versionId")?,
                argument(&args, "loaderType")?,
                argument(&args, "loaderVersion")?,
                argument(&args, "root")?,
            )
            .await?,
        ),
        "get_bedrock_mods" => to_value(crate::get_bedrock_mods(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "root")?,
        )?),
        "toggle_bedrock_mod" => to_value(crate::toggle_bedrock_mod(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "modId")?,
            argument(&args, "enabled")?,
            argument(&args, "root")?,
        )?),
        "delete_bedrock_mod" => to_value(crate::delete_bedrock_mod(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "modId")?,
            argument(&args, "root")?,
        )?),
        "install_bedrock_mod_file" => to_value(crate::install_bedrock_mod_file(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "filePath")?,
            argument(&args, "root")?,
        )?),
        "get_bedrock_packs" => to_value(crate::get_bedrock_packs(
            app.clone(),
            argument(&args, "root")?,
        )?),
        "set_bedrock_pack_enabled" => to_value(crate::set_bedrock_pack_enabled(
            app.clone(),
            argument(&args, "path")?,
            argument(&args, "enabled")?,
            argument(&args, "root")?,
        )?),
        "delete_bedrock_pack" => to_value(crate::delete_bedrock_pack(
            app.clone(),
            argument(&args, "path")?,
            argument(&args, "root")?,
        )?),
        "import_bedrock_pack_file" => to_value(crate::import_bedrock_pack_file(
            app.clone(),
            argument(&args, "filePath")?,
            argument(&args, "root")?,
        )?),
        "get_java_mods" => to_value(crate::get_java_mods(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "root")?,
        )?),
        "toggle_java_mod" => to_value(crate::toggle_java_mod(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "fileName")?,
            argument(&args, "enabled")?,
            argument(&args, "root")?,
        )?),
        "delete_java_mod" => to_value(crate::delete_java_mod(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "fileName")?,
            argument(&args, "root")?,
        )?),
        "install_java_mod_file" => to_value(crate::install_java_mod_file(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "filePath")?,
            argument(&args, "root")?,
        )?),
        "get_java_resource_packs" => to_value(crate::get_java_resource_packs(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "toggle_java_resource_pack" => to_value(crate::toggle_java_resource_pack(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "fileName")?,
            argument(&args, "enabled")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "delete_java_resource_pack" => to_value(crate::delete_java_resource_pack(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "fileName")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "install_java_resource_pack_file" => to_value(crate::install_java_resource_pack_file(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "filePath")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "get_java_worlds" => to_value(crate::get_java_worlds(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "delete_java_world" => to_value(crate::delete_java_world(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "folder")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "install_java_world_file" => to_value(crate::install_java_world_file(
            app.clone(),
            argument(&args, "versionId")?,
            argument(&args, "filePath")?,
            argument(&args, "isolation")?,
            argument(&args, "root")?,
        )?),
        "get_bedrock_worlds" => to_value(crate::get_bedrock_worlds(
            app.clone(),
            argument(&args, "root")?,
        )?),
        "delete_bedrock_world" => to_value(crate::delete_bedrock_world(
            app.clone(),
            argument(&args, "path")?,
            argument(&args, "root")?,
        )?),
        "import_bedrock_world_file" => to_value(crate::import_bedrock_world_file(
            app.clone(),
            argument(&args, "filePath")?,
            argument(&args, "root")?,
        )?),
        "ms_login_begin" => to_value(crate::ms_login_begin(argument(&args, "clientId")?).await?),
        "ms_login_poll" => to_value(
            crate::ms_login_poll(
                app.clone(),
                argument(&args, "deviceCode")?,
                argument(&args, "clientId")?,
            )
            .await?,
        ),
        "get_ms_account" => {
            to_value(crate::get_ms_account(app.clone(), argument(&args, "clientId")?).await?)
        }
        "ms_sign_out" => to_value(crate::ms_sign_out(app.clone()).await?),
        "get_multiplayer_install_state" => {
            to_value(crate::multiplayer::get_multiplayer_install_state(
                argument(&args, "root")?,
                app.state::<MultiplayerState>(),
            ))
        }
        "install_easytier" => to_value(
            crate::multiplayer::install_easytier(
                app.clone(),
                argument(&args, "root")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "get_multiplayer_status" => to_value(crate::multiplayer::get_multiplayer_status(
            app.clone(),
            argument(&args, "root")?,
            app.state::<MultiplayerState>(),
        )),
        "start_multiplayer" => to_value(
            crate::multiplayer::start_multiplayer(
                app.clone(),
                argument(&args, "root")?,
                argument(&args, "config")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "stop_multiplayer" => to_value(crate::multiplayer::stop_multiplayer(
            app.clone(),
            argument(&args, "root")?,
            app.state::<MultiplayerState>(),
        )),
        "start_room_resources" => to_value(
            crate::multiplayer::start_room_resources(
                argument(&args, "root")?,
                argument(&args, "versionId")?,
                argument(&args, "isolation")?,
                argument(&args, "secret")?,
                argument(&args, "token")?,
                argument(&args, "port")?,
                argument(&args, "hostPort")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "fetch_room_resources" => to_value(
            crate::multiplayer::fetch_room_resources(
                argument(&args, "host")?,
                argument(&args, "port")?,
                argument(&args, "token")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "get_multiplayer_peers" => to_value(
            crate::multiplayer::get_multiplayer_peers(
                argument(&args, "root")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "get_multiplayer_firewall_status" => to_value(
            crate::multiplayer::get_multiplayer_firewall_status(
                argument(&args, "root")?,
                argument(&args, "listenPort")?,
                argument(&args, "hostPort")?,
                argument(&args, "overlayIpv4")?,
            )
            .await?,
        ),
        "setup_multiplayer_firewall" => to_value(
            crate::multiplayer::setup_multiplayer_firewall(
                argument(&args, "root")?,
                argument(&args, "listenPort")?,
                argument(&args, "hostPort")?,
                argument(&args, "overlayIpv4")?,
            )
            .await?,
        ),
        "get_local_ipv6_addresses" => {
            to_value(crate::multiplayer::get_local_ipv6_addresses().await)
        }
        "probe_multiplayer_endpoint" => {
            to_value(crate::multiplayer::probe_multiplayer_endpoint(argument(&args, "peer")?).await)
        }
        "read_minecraft_lan_port" => to_value(
            crate::multiplayer::read_minecraft_lan_port(
                argument(&args, "root")?,
                argument(&args, "versionId")?,
                argument(&args, "isolation")?,
            )
            .await,
        ),
        "probe_minecraft_host" => to_value(
            crate::multiplayer::probe_minecraft_host(
                argument(&args, "host")?,
                argument(&args, "port")?,
                app.state::<MultiplayerState>(),
            )
            .await?,
        ),
        "start_lan_bridge" => to_value(
            crate::multiplayer::start_lan_bridge(
                app.clone(),
                app.state::<MultiplayerState>(),
                argument(&args, "host")?,
                argument(&args, "port")?,
                argument(&args, "motd")?,
            )
            .await?,
        ),
        "stop_lan_bridge" => to_value(crate::multiplayer::stop_lan_bridge(
            app.clone(),
            app.state::<MultiplayerState>(),
            argument(&args, "localPort")?,
        )),
        _ => Err(format!("Unknown command: {command}")),
    }
}
pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("failed to start async runtime");
    let app = AppHandle::default();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("Invalid request: {error}");
                continue;
            }
        };
        let app = app.clone();
        runtime.spawn(async move {
            let result = dispatch(app, &request.command, request.args).await;
            match result {
                Ok(value) => send(json!({"id": request.id, "result": value})),
                Err(error) => send(json!({"id": request.id, "error": error})),
            }
        });
    }
    crate::multiplayer::shutdown(app.state::<MultiplayerState>());
}
