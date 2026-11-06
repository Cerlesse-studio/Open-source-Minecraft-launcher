//! LittleSkin（外置登录）账号。
//!
//! 流程与微软登录同构，但认证体系完全不同：
//!   1. OAuth 2.0 设备授权流 -> https://open.littleskin.cn/oauth/device_code
//!   2. 轮询令牌端点，直到用户在浏览器里完成授权
//!   3. 用 OAuth access token 调 Yggdrasil 的 `/authserver/oauth` 换取
//!      Minecraft 会话令牌（这一步才是游戏真正使用的凭据）
//!   4. 启动时通过 authlib-injector 把 Yggdrasil API 地址注入 JVM
//!
//! 与微软账号的区别：
//!   - 不接触用户密码，也不代表正版授权；只能用于同样配置了外置登录的服务器。
//!   - `user_type` 必须是 `mojang`，并且必须带 `-javaagent:authlib-injector.jar=<api>`。
//!   - 设备授权流需要 LittleSkin 侧把应用加入白名单，否则返回 `invalid_client`。
//!
//! 令牌保存在独立的 `littleskin_account.json`（与微软账号的 `account.json` 并列），
//! 文件权限沿用 `auth::store_account` 的收紧策略。

use crate::auth::{
    self, AccountRecord, DeviceCodeInfo, Entitlements, MinecraftToken, MsProfile,
};
use crate::net;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// LittleSkin 的 Yggdrasil API 根地址（authlib-injector 参数里用的就是它）。
pub const DEFAULT_YGGDRASIL_API: &str = "https://littleskin.cn/api/yggdrasil";
const DEVICE_CODE_URL: &str = "https://open.littleskin.cn/oauth/device_code";
const TOKEN_URL: &str = "https://open.littleskin.cn/oauth/token";
/// `Yggdrasil.PlayerProfiles.Read` 与 `Select` 互斥，这里用 Select：
/// 授权时由用户在 LittleSkin 页面上选好角色，启动器直接拿到结果。
const SCOPE: &str =
    "openid offline_access Yggdrasil.MinecraftToken.Create Yggdrasil.PlayerProfiles.Select";
const INJECTOR_LATEST_URL: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";
const INJECTOR_LATEST_MIRROR: &str =
    "https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json";
/// LittleSkin 的 Minecraft 令牌不会过期，这里给一个续期周期，避免永久复用。
const SESSION_LIFETIME_SECS: u64 = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    user_code: String,
    device_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_expires_in() -> u64 {
    300
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Clone, Default)]
struct OAuthTokens {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_at: u64,
}

#[derive(Debug, Deserialize, Default)]
struct OAuthTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

/// 一个可选角色。`id` 是 LittleSkin 的玩家 UUID（通常不带连字符）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileChoice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct YggdrasilAuthResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "selectedProfile", default)]
    selected_profile: Option<ProfileChoice>,
    #[serde(rename = "availableProfiles", default)]
    available_profiles: Vec<ProfileChoice>,
}

/// LittleSkin 账号的独立视图：它不是微软账号，所以没有 `provider` 标记，
/// 也没有微软的 XUID、皮肤和双版本授权字段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LittleSkinView {
    pub signed_in: bool,
    pub client_id: String,
    pub uuid: String,
    pub name: String,
    pub yggdrasil_api: Option<String>,
    /// Unix seconds; the Java session must still be valid when the game starts.
    pub session_expires_at: u64,
    pub refresh_expires_at: u64,
    /// Set when the stored session could not be renewed.
    pub session_error: Option<String>,
}

/// Build the standalone LittleSkin view from a stored record.
pub fn view(record: &AccountRecord) -> LittleSkinView {
    LittleSkinView {
        signed_in: true,
        client_id: record.client_id.clone(),
        uuid: record.profile.id.clone(),
        name: record.profile.name.clone(),
        yggdrasil_api: record.yggdrasil_api.clone(),
        session_expires_at: record.minecraft.expires_at,
        refresh_expires_at: record.expires_at,
        session_error: None,
    }
}

/// 一次登录轮询的结果，直接序列化给登录对话框。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    /// `pending` / `slow_down` / `success` / `select_profile`
    pub state: String,
    pub message: Option<String>,
    pub account: Option<LittleSkinView>,
    /// 需要用户挑选角色时给出候选列表。
    pub profiles: Vec<ProfileChoice>,
    /// 挑选角色时回传给 `select_profile` 的临时句柄。
    pub pending_id: Option<String>,
}

impl LoginPoll {
    fn pending() -> Self {
        Self {
            state: "pending".to_string(),
            message: None,
            account: None,
            profiles: Vec::new(),
            pending_id: None,
        }
    }

    fn slow_down() -> Self {
        Self {
            state: "slow_down".to_string(),
            message: None,
            account: None,
            profiles: Vec::new(),
            pending_id: None,
        }
    }

    pub fn success(record: &AccountRecord) -> Self {
        Self {
            state: "success".to_string(),
            message: None,
            account: Some(view(record)),
            profiles: Vec::new(),
            pending_id: None,
        }
    }

    fn select(pending_id: String, profiles: Vec<ProfileChoice>) -> Self {
        Self {
            state: "select_profile".to_string(),
            message: Some("该账号有多个角色，请选择要使用的角色。".to_string()),
            account: None,
            profiles,
            pending_id: Some(pending_id),
        }
    }
}

#[derive(Debug, Clone)]
pub enum LoginOutcome {
    Pending,
    SlowDown,
    Done(Box<AccountRecord>),
    Select {
        pending_id: String,
        profiles: Vec<ProfileChoice>,
    },
}

impl LoginOutcome {
    pub fn into_poll(self) -> LoginPoll {
        match self {
            LoginOutcome::Pending => LoginPoll::pending(),
            LoginOutcome::SlowDown => LoginPoll::slow_down(),
            LoginOutcome::Done(record) => LoginPoll::success(&record),
            LoginOutcome::Select {
                pending_id,
                profiles,
            } => LoginPoll::select(pending_id, profiles),
        }
    }
}

/// 已授权但还没选定角色的登录：OAuth 令牌只留在后端内存里，绝不发给前端。
struct PendingLogin {
    client_id: String,
    oauth: OAuthTokens,
    yggdrasil_api: String,
    profiles: Vec<ProfileChoice>,
}

static PENDING: OnceLock<Mutex<HashMap<String, PendingLogin>>> = OnceLock::new();

fn pending_map() -> &'static Mutex<HashMap<String, PendingLogin>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// 错误文案
// ---------------------------------------------------------------------------

fn oauth_error(code: &str, description: Option<&str>, client_id: &str) -> String {
    match code {
        "access_denied" => "你拒绝了 LittleSkin 授权。".to_string(),
        "expired_token" => "授权码已过期，请重新获取。".to_string(),
        "invalid_client" | "unauthorized_client" => format!(
            "LittleSkin 不接受这个客户端 ID（{client_id}）。请确认应用已创建，并已向 support@littleskin.cn 申请设备代码流白名单。"
        ),
        "invalid_grant" => "授权已失效，请重新登录。".to_string(),
        other => {
            let hint = description.unwrap_or("").trim();
            if hint.is_empty() {
                format!("LittleSkin 登录失败：{other}")
            } else {
                format!("LittleSkin 登录失败：{hint}")
            }
        }
    }
}

fn yggdrasil_error(status: reqwest::StatusCode, value: &serde_json::Value) -> String {
    let detail = value
        .get("errorMessage")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    match status.as_u16() {
        401 | 403 => "LittleSkin 拒绝了这次会话请求，请重新授权登录。".to_string(),
        404 => "LittleSkin 找不到这个角色，可能已在网站上被删除。".to_string(),
        _ if detail.is_empty() => format!("LittleSkin 会话请求失败（HTTP {status}）"),
        _ => format!("LittleSkin 会话请求失败（HTTP {status}）：{detail}"),
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async fn post_form(
    url: &str,
    form: &[(&str, &str)],
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let response = net::client()
        .post(url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|error| format!("请求 {url} 失败: {error}"))?;
    let status = response.status();
    let value = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok((status, value))
}

fn tokens_from(value: serde_json::Value) -> Result<OAuthTokens, String> {
    let parsed: OAuthTokenResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析 LittleSkin 登录响应: {error}"))?;
    if let Some(code) = parsed.error.as_deref() {
        return Err(oauth_error(code, parsed.error_description.as_deref(), ""));
    }
    let access_token = parsed
        .access_token
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "LittleSkin 没有返回访问令牌".to_string())?;
    Ok(OAuthTokens {
        access_token,
        refresh_token: parsed.refresh_token.filter(|token| !token.is_empty()),
        id_token: parsed.id_token.filter(|token| !token.is_empty()),
        expires_at: auth::now_secs() + parsed.expires_in.unwrap_or(3600),
    })
}

// ---------------------------------------------------------------------------
// ID Token
// ---------------------------------------------------------------------------

/// 读取 ID Token 的声明。
///
/// 这里**不校验 JWT 签名**：令牌是通过 TLS 直接从签发端点拿到的，签名并不能
/// 提供比这条信道更强的保证；真正决定身份的是随后用 OAuth access token 调用
/// Yggdrasil 接口时服务端的校验结果。因此这里只做 `iss` / `aud` / `exp` 的
/// 一致性检查，并且**从不**把令牌里的 UUID 当作可信身份直接使用。
fn id_token_claims(id_token: &str) -> Option<serde_json::Value> {
    use base64::Engine;
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn claim_matches_audience(claims: &serde_json::Value, client_id: &str) -> bool {
    match claims.get("aud") {
        Some(serde_json::Value::String(value)) => value == client_id,
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str())
            .any(|value| value == client_id),
        _ => false,
    }
}

fn issuer_is_littleskin(claims: &serde_json::Value) -> bool {
    let Some(issuer) = claims.get("iss").and_then(|value| value.as_str()) else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(issuer) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    url.host_str()
        .map(|host| {
            let host = host.to_ascii_lowercase();
            host == "littleskin.cn" || host.ends_with(".littleskin.cn")
        })
        .unwrap_or(false)
}

/// 授权时用户选中的角色（`Yggdrasil.PlayerProfiles.Select`）。
fn selected_profile_from_claims(claims: &serde_json::Value) -> Option<ProfileChoice> {
    let profile = claims
        .get("selectedProfile")
        .or_else(|| claims.get("selected_profile"))?;
    let id = profile.get("id")?.as_str()?.to_string();
    let name = profile.get("name")?.as_str()?.to_string();
    if id.is_empty() || name.is_empty() {
        return None;
    }
    Some(ProfileChoice { id, name })
}

// ---------------------------------------------------------------------------
// 设备授权流
// ---------------------------------------------------------------------------

/// 第 1 步：申请设备码。`client_id` 由用户在设置里填写（LittleSkin 应用 ID）。
pub async fn begin_device_login(client_id: &str) -> Result<DeviceCodeInfo, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err(
            "请先在设置里填写 LittleSkin 应用的客户端 ID（在 https://littleskin.cn/oauth/applications 创建应用后获得）。"
                .to_string(),
        );
    }

    let (status, value) = post_form(
        DEVICE_CODE_URL,
        &[("client_id", client_id), ("scope", SCOPE)],
    )
    .await?;

    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_error");
        let description = value.get("error_description").and_then(|v| v.as_str());
        return Err(oauth_error(code, description, client_id));
    }

    let parsed: DeviceCodeResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析 LittleSkin 返回的验证码: {error}"))?;

    Ok(DeviceCodeInfo {
        user_code: parsed.user_code,
        device_code: parsed.device_code,
        verification_uri: parsed.verification_uri,
        verification_uri_complete: parsed
            .verification_uri_complete
            .filter(|url| !url.is_empty()),
        expires_in: parsed.expires_in,
        interval: parsed.interval.max(1),
        message: "请在浏览器中登录 LittleSkin 并选择要使用的角色。".to_string(),
    })
}

/// 第 2 步：轮询授权结果，成功后立刻换取 Minecraft 会话。
pub async fn poll_device_login(client_id: &str, device_code: &str) -> Result<LoginOutcome, String> {
    let client_id = client_id.trim();
    let (status, value) = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id),
            ("device_code", device_code),
        ],
    )
    .await?;

    if let Some(code) = value.get("error").and_then(|v| v.as_str()) {
        return match code {
            "authorization_pending" => Ok(LoginOutcome::Pending),
            "slow_down" => Ok(LoginOutcome::SlowDown),
            other => Err(oauth_error(
                other,
                value.get("error_description").and_then(|v| v.as_str()),
                client_id,
            )),
        };
    }
    if !status.is_success() {
        return Err(format!("LittleSkin 登录失败（HTTP {status}）"));
    }

    let oauth = tokens_from(value)?;
    let selected = oauth
        .id_token
        .as_deref()
        .and_then(id_token_claims)
        .and_then(|claims| {
            if !issuer_is_littleskin(&claims) || !claim_matches_audience(&claims, client_id) {
                return None;
            }
            let expired = claims
                .get("exp")
                .and_then(|value| value.as_u64())
                .map(|exp| exp <= auth::now_secs())
                .unwrap_or(false);
            if expired {
                return None;
            }
            selected_profile_from_claims(&claims)
        });

    finish_login(client_id, oauth, selected).await
}

/// 第 3 步（仅多角色时）：用户选定角色后补完登录。
pub async fn select_profile(pending_id: &str, uuid: &str) -> Result<AccountRecord, String> {
    let pending = pending_map()
        .lock()
        .map_err(|_| "登录状态异常，请重新登录".to_string())?
        .remove(pending_id)
        .ok_or_else(|| "登录已过期，请重新获取授权码。".to_string())?;

    let uuid = uuid.trim();
    if !pending.profiles.iter().any(|profile| profile.id == uuid) {
        return Err("选择的角色不在该账号的角色列表中。".to_string());
    }

    let session = create_minecraft_session(&pending.oauth.access_token, &pending.yggdrasil_api, Some(uuid))
        .await?;
    let profile = session
        .selected_profile
        .ok_or_else(|| "LittleSkin 没有返回所选角色的会话".to_string())?;
    Ok(build_record(
        &pending.client_id,
        pending.oauth,
        &pending.yggdrasil_api,
        session.access_token,
        profile,
    ))
}

/// 用户取消登录时丢掉待选角色的临时状态（里面存着还没落盘的 OAuth 令牌）。
pub fn cancel_pending(pending_id: &str) {
    if let Ok(mut map) = pending_map().lock() {
        map.remove(pending_id);
    }
}

async fn finish_login(
    client_id: &str,
    oauth: OAuthTokens,
    selected: Option<ProfileChoice>,
) -> Result<LoginOutcome, String> {
    let api = DEFAULT_YGGDRASIL_API.to_string();
    let session =
        create_minecraft_session(&oauth.access_token, &api, selected.as_ref().map(|p| p.id.as_str()))
            .await?;

    if let Some(profile) = session.selected_profile {
        return Ok(LoginOutcome::Done(Box::new(build_record(
            client_id,
            oauth,
            &api,
            session.access_token,
            profile,
        ))));
    }

    // 没有 selectedProfile：说明授权时没选角色（或该账号有多个角色）。
    let profiles = session.available_profiles;
    match profiles.len() {
        0 => Err("该 LittleSkin 账号还没有创建角色，请先在 littleskin.cn 创建角色后再登录。".to_string()),
        1 => {
            let only = profiles[0].clone();
            let session =
                create_minecraft_session(&oauth.access_token, &api, Some(&only.id)).await?;
            let profile = session
                .selected_profile
                .ok_or_else(|| "LittleSkin 没有返回角色会话".to_string())?;
            Ok(LoginOutcome::Done(Box::new(build_record(
                client_id,
                oauth,
                &api,
                session.access_token,
                profile,
            ))))
        }
        _ => {
            let pending_id = random_id();
            pending_map()
                .lock()
                .map_err(|_| "登录状态异常，请重新登录".to_string())?
                .insert(
                    pending_id.clone(),
                    PendingLogin {
                        client_id: client_id.to_string(),
                        oauth,
                        yggdrasil_api: api,
                        profiles: profiles.clone(),
                    },
                );
            Ok(LoginOutcome::Select {
                pending_id,
                profiles,
            })
        }
    }
}

/// 用 OAuth access token 换 Minecraft 会话令牌。
///
/// 传 `uuid` 时服务端直接返回该角色的会话；不传时返回 `availableProfiles`，
/// 由启动器让用户选择后再请求一次。
async fn create_minecraft_session(
    oauth_access_token: &str,
    yggdrasil_api: &str,
    uuid: Option<&str>,
) -> Result<YggdrasilAuthResponse, String> {
    let url = format!("{}/authserver/oauth", yggdrasil_api.trim_end_matches('/'));
    let body = match uuid {
        Some(uuid) => serde_json::json!({ "uuid": uuid }),
        None => serde_json::json!({}),
    };
    let response = net::client()
        .post(&url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/json")
        .bearer_auth(oauth_access_token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("请求 LittleSkin 会话失败: {error}"))?;

    let status = response.status();
    let value = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(yggdrasil_error(status, &value));
    }
    serde_json::from_value(value).map_err(|error| format!("无法解析 LittleSkin 会话: {error}"))
}

fn build_record(
    client_id: &str,
    oauth: OAuthTokens,
    yggdrasil_api: &str,
    minecraft_access_token: String,
    profile: ProfileChoice,
) -> AccountRecord {
    AccountRecord {
        provider: "littleskin".to_string(),
        client_id: client_id.to_string(),
        refresh_token: oauth.refresh_token.unwrap_or_default(),
        expires_at: oauth.expires_at,
        oauth_access_token: Some(oauth.access_token),
        yggdrasil_api: Some(yggdrasil_api.to_string()),
        minecraft: MinecraftToken {
            access_token: minecraft_access_token,
            expires_at: auth::now_secs() + SESSION_LIFETIME_SECS,
            xuid: String::new(),
            uhs: String::new(),
        },
        profile: MsProfile {
            id: profile.id,
            name: profile.name,
            skin_url: None,
        },
        entitlements: Entitlements {
            java: true,
            bedrock: false,
            game_pass: false,
            items: Vec::new(),
        },
        saved_at: auth::now_secs(),
    }
}

/// 随机句柄，只用于把「待选角色」的登录状态和前端对应起来。
fn random_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(auth::now_secs());
    hasher.write_u32(std::process::id());
    format!("{:016x}{:016x}", hasher.finish(), {
        let mut second = RandomState::new().build_hasher();
        second.write_u64(auth::now_secs() ^ 0x9e37_79b9_7f4a_7c15);
        second.finish()
    })
}

// ---------------------------------------------------------------------------
// 续期
// ---------------------------------------------------------------------------

/// 用 refresh token 换新的 OAuth 令牌，再重新签发 Minecraft 会话。
pub async fn refresh_account(record: &AccountRecord) -> Result<AccountRecord, String> {
    let api = record
        .yggdrasil_api
        .clone()
        .unwrap_or_else(|| DEFAULT_YGGDRASIL_API.to_string());

    let oauth = if record.refresh_token.is_empty() {
        // 没有 refresh token 时只能靠还没过期的 access token 续一次。
        match record.oauth_access_token.clone() {
            Some(token) if record.expires_at > auth::now_secs() => OAuthTokens {
                access_token: token,
                refresh_token: None,
                id_token: None,
                expires_at: record.expires_at,
            },
            _ => return Err("LittleSkin 授权已过期，请重新登录。".to_string()),
        }
    } else {
        let (status, value) = post_form(
            TOKEN_URL,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", record.client_id.as_str()),
                ("refresh_token", record.refresh_token.as_str()),
            ],
        )
        .await?;
        if let Some(code) = value.get("error").and_then(|v| v.as_str()) {
            return Err(oauth_error(
                code,
                value.get("error_description").and_then(|v| v.as_str()),
                &record.client_id,
            ));
        }
        if !status.is_success() {
            return Err(format!("刷新 LittleSkin 登录状态失败（HTTP {status}）"));
        }
        let mut tokens = tokens_from(value)?;
        if tokens.refresh_token.is_none() {
            tokens.refresh_token = Some(record.refresh_token.clone());
        }
        tokens
    };

    let session = create_minecraft_session(
        &oauth.access_token,
        &api,
        Some(record.profile.id.as_str()),
    )
    .await?;
    let profile = match session.selected_profile {
        Some(profile) => profile,
        None => session
            .available_profiles
            .into_iter()
            .find(|profile| profile.id == record.profile.id)
            .ok_or_else(|| "LittleSkin 上已找不到这个角色，请重新登录。".to_string())?,
    };
    Ok(build_record(
        &record.client_id,
        oauth,
        &api,
        session.access_token,
        profile,
    ))
}

// ---------------------------------------------------------------------------
// authlib-injector
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct InjectorLatest {
    version: String,
    download_url: String,
    #[serde(default)]
    checksums: HashMap<String, String>,
}

/// 下载（或复用）authlib-injector，并校验官方公布的 SHA-256。
///
/// 校验和来自官方 artifact 服务（镜像返回同一份 JSON），因此即使走了镜像，
/// 被篡改的 JAR 也会在启动前被拒绝。
pub async fn ensure_injector(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("authlib-injector");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("无法创建 authlib-injector 目录: {error}"))?;

    let mut latest: Option<InjectorLatest> = None;
    let mut last_error = String::new();
    for url in [INJECTOR_LATEST_URL, INJECTOR_LATEST_MIRROR] {
        match net::fetch_json::<InjectorLatest>(url, Duration::from_secs(20), 2).await {
            Ok(value) => {
                latest = Some(value);
                break;
            }
            Err(error) => last_error = error,
        }
    }
    let latest = latest.ok_or_else(|| format!("无法获取 authlib-injector 版本信息: {last_error}"))?;

    let expected = latest
        .checksums
        .get("sha256")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let jar = dir.join(format!("authlib-injector-{}.jar", latest.version));

    if jar.is_file() {
        if let Some(expected) = expected.as_deref() {
            if sha256_file(&jar).await.map(|actual| actual == expected).unwrap_or(false) {
                return Ok(jar);
            }
        } else if std::fs::metadata(&jar).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(jar);
        }
        let _ = tokio::fs::remove_file(&jar).await;
    }

    net::download_file_with_mirrors(
        &latest.download_url,
        &jar,
        None,
        None,
        net::download_threads().clamp(1, 8),
        None,
        None,
    )
    .await
    .map_err(|error| format!("下载 authlib-injector 失败: {error}"))?;

    if let Some(expected) = expected.as_deref() {
        let actual = sha256_file(&jar).await?;
        if actual != expected {
            let _ = tokio::fs::remove_file(&jar).await;
            return Err("authlib-injector 校验失败（SHA-256 不匹配），已删除下载的文件。".to_string());
        }
    }

    Ok(jar)
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let data = tokio::fs::read(path)
        .await
        .map_err(|error| format!("无法读取 {}: {error}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(data)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(json: serde_json::Value) -> serde_json::Value {
        json
    }

    #[test]
    fn device_code_defaults_match_the_documented_flow() {
        let parsed: DeviceCodeResponse = serde_json::from_str(
            r#"{"user_code":"ABCD-EFGH","device_code":"dc","verification_uri":"https://open.littleskin.cn/oauth/link"}"#,
        )
        .unwrap();
        assert_eq!(parsed.interval, 5);
        assert_eq!(parsed.expires_in, 300);
        assert!(parsed.verification_uri_complete.is_none());
    }

    #[test]
    fn id_token_claims_are_decoded_from_the_payload() {
        use base64::Engine;
        let payload = serde_json::json!({
            "iss": "https://open.littleskin.cn",
            "aud": "my-client",
            "exp": auth::now_secs() + 600,
            "selectedProfile": { "id": "069a79f444e94726a5befca90e38aaf5", "name": "Steve" }
        });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(payload.to_string().as_bytes());
        let token = format!("header.{encoded}.signature");
        let decoded = id_token_claims(&token).expect("payload decodes");
        assert!(issuer_is_littleskin(&decoded));
        assert!(claim_matches_audience(&decoded, "my-client"));
        assert!(!claim_matches_audience(&decoded, "other-client"));
        let profile = selected_profile_from_claims(&decoded).unwrap();
        assert_eq!(profile.name, "Steve");
        assert_eq!(profile.id, "069a79f444e94726a5befca90e38aaf5");
    }

    #[test]
    fn audience_accepts_arrays_and_issuer_must_be_littleskin() {
        let array = claims(serde_json::json!({ "aud": ["a", "b"] }));
        assert!(claim_matches_audience(&array, "b"));
        assert!(!claim_matches_audience(&array, "c"));

        assert!(issuer_is_littleskin(&serde_json::json!({
            "iss": "https://open.littleskin.cn"
        })));
        assert!(!issuer_is_littleskin(&serde_json::json!({
            "iss": "https://littleskin.cn.evil.example"
        })));
        assert!(!issuer_is_littleskin(&serde_json::json!({
            "iss": "http://littleskin.cn"
        })));
        assert!(!issuer_is_littleskin(&serde_json::json!({})));
    }

    #[test]
    fn oauth_errors_explain_the_whitelist_requirement() {
        let message = oauth_error("invalid_client", None, "abc");
        assert!(message.contains("abc"), "{message}");
        assert!(message.contains("白名单"), "{message}");
        assert!(oauth_error("access_denied", None, "id").contains("拒绝"));
        assert!(oauth_error("expired_token", None, "id").contains("过期"));
    }

    #[test]
    fn yggdrasil_session_response_is_parsed() {
        let parsed: YggdrasilAuthResponse = serde_json::from_str(
            r#"{
                "accessToken": "mc-token",
                "clientToken": "client",
                "selectedProfile": { "id": "uuid", "name": "Alex" },
                "availableProfiles": [ { "id": "uuid", "name": "Alex" } ]
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.access_token, "mc-token");
        assert_eq!(parsed.selected_profile.unwrap().name, "Alex");
        assert_eq!(parsed.available_profiles.len(), 1);
    }

    #[test]
    fn records_mark_themselves_as_external() {
        let record = build_record(
            "client",
            OAuthTokens {
                access_token: "oauth".to_string(),
                refresh_token: Some("refresh".to_string()),
                id_token: None,
                expires_at: auth::now_secs() + 3600,
            },
            DEFAULT_YGGDRASIL_API,
            "mc-token".to_string(),
            ProfileChoice {
                id: "uuid".to_string(),
                name: "Steve".to_string(),
            },
        );
        assert!(record.is_external());
        assert_eq!(record.provider, "littleskin");
        assert_eq!(record.yggdrasil_api.as_deref(), Some(DEFAULT_YGGDRASIL_API));
        assert_eq!(record.minecraft.access_token, "mc-token");
        assert!(record.entitlements.java);
        assert!(!record.entitlements.bedrock);
        assert!(record.session_alive());
        let seen = view(&record);
        assert!(seen.signed_in);
        assert_eq!(seen.name, "Steve");
        assert_eq!(seen.uuid, "uuid");
    }

    #[test]
    fn pending_handles_are_unique() {
        assert_ne!(random_id(), random_id());
    }
}
