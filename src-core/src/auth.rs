//! Microsoft (正版) account sign-in.
//!
//! The launcher signs in once and then uses that account for both editions:
//! the Java session token comes from `login_with_xbox`, while Bedrock ownership
//! is read from the licence endpoint (the Windows Store client signs itself in
//! with the same Microsoft account, which is why a launcher cannot hand it a
//! token the way it does for Java).
//!
//! Flow, as used by PCL / Prism / GravitLauncher:
//!   1. OAuth 2.0 device code  -> https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode
//!   2. poll the token endpoint until the user finishes in a browser
//!   3. Xbox Live user auth    -> https://user.auth.xboxlive.com/user/authenticate
//!   4. XSTS authorization     -> https://xsts.auth.xboxlive.com/xsts/authorize
//!   5. Minecraft login        -> https://api.minecraftservices.com/authentication/login_with_xbox
//!   6. profile + entitlements -> https://api.minecraftservices.com/minecraft/profile
//!
//! Tokens are stored in `account.json` under the launcher's data directory. The
//! refresh token is the long-lived secret, so the file is written with the
//! tightest permissions the platform allows and never leaves the machine.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Public client id of a launcher application (device-code flow, no secret).
/// Overridable in the launcher settings for anyone who registered their own
/// Azure application — that is the only reliable fallback when a shared public
/// id is throttled or withdrawn.
pub const DEFAULT_CLIENT_ID: &str = "d772766b-19b4-4f69-b353-989f890c5d3b";

const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPE: &str = "XboxLive.signin offline_access";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const ENTITLEMENTS_URL: &str = "https://api.minecraftservices.com/entitlements/license";

const ACCOUNT_FILE: &str = "account.json";
/// Refresh a little before expiry so a launch never fails on a dead session.
const SESSION_SLACK_SECS: u64 = 300;

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn client_id_of(custom: Option<&str>) -> String {
    custom
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CLIENT_ID)
        .to_string()
}

/// Whether a URL may be opened inside the launcher-owned sign-in window.
///
/// The window renders a real Microsoft login page, so it must never be pointed
/// at anything but Microsoft's own sign-in hosts — anything else would turn it
/// into the perfect place to show a fake login form.
pub fn is_microsoft_login_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    const ROOTS: [&str; 6] = [
        "microsoft.com",
        "live.com",
        "microsoftonline.com",
        "msauth.net",
        "msftauth.net",
        "xboxlive.com",
    ];
    ROOTS
        .iter()
        .any(|root| host == *root || host.ends_with(&format!(".{root}")))
}

/// Where the account lives: next to the launcher's own data, not inside a game
/// root, so switching versions or roots does not sign the user out.
pub fn account_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ACCOUNT_FILE)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MsProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skin_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entitlements {
    /// Minecraft: Java Edition (`product_minecraft`).
    pub java: bool,
    /// Bedrock Edition (`product_minecraft_bedrock`).
    pub bedrock: bool,
    /// Game Pass (either tier) — grants both editions while it lasts.
    pub game_pass: bool,
    /// Raw item names, kept for diagnostics.
    #[serde(default)]
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftToken {
    pub access_token: String,
    pub expires_at: u64,
    pub xuid: String,
    pub uhs: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRecord {
    pub client_id: String,
    /// Microsoft refresh token — the only long-lived credential we keep.
    pub refresh_token: String,
    /// Microsoft access token expiry (unix seconds).
    pub expires_at: u64,
    pub minecraft: MinecraftToken,
    pub profile: MsProfile,
    pub entitlements: Entitlements,
    pub saved_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub signed_in: bool,
    pub client_id: String,
    pub uuid: String,
    pub name: String,
    pub skin_url: Option<String>,
    pub xuid: String,
    pub entitlements: Entitlements,
    /// Unix seconds; the Java session must still be valid when the game starts.
    pub session_expires_at: u64,
    pub refresh_expires_at: u64,
    /// Set when the stored session could not be renewed, in user-facing words.
    pub session_error: Option<String>,
}

impl AccountRecord {
    pub fn view(&self) -> AccountView {
        AccountView {
            signed_in: true,
            client_id: self.client_id.clone(),
            uuid: self.profile.id.clone(),
            name: self.profile.name.clone(),
            skin_url: self.profile.skin_url.clone(),
            xuid: self.minecraft.xuid.clone(),
            entitlements: self.entitlements.clone(),
            session_expires_at: self.minecraft.expires_at,
            refresh_expires_at: self.expires_at,
            session_error: None,
        }
    }

    /// True while the Java session token can still be handed to the game.
    pub fn session_alive(&self) -> bool {
        self.minecraft.expires_at > now_secs() + SESSION_SLACK_SECS
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub device_code: String,
    pub verification_uri: String,
    /// Verification link with the one-time code already filled in, so the
    /// login page opens ready to submit without the user typing anything.
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum DeviceOutcome {
    /// User has not finished in the browser yet; poll again.
    Pending,
    SlowDown,
    Done(Box<AccountRecord>),
}

/// What the login dialog polls for: `pending` keeps the dialog showing the
/// code, `slow_down` tells it to back off, `success` carries the account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPoll {
    pub state: String,
    pub message: Option<String>,
    pub account: Option<AccountView>,
}

impl AccountPoll {
    pub fn pending() -> Self {
        Self {
            state: "pending".to_string(),
            message: None,
            account: None,
        }
    }

    pub fn slow_down() -> Self {
        Self {
            state: "slow_down".to_string(),
            message: None,
            account: None,
        }
    }

    pub fn success(record: &AccountRecord) -> Self {
        Self {
            state: "success".to_string(),
            message: None,
            account: Some(record.view()),
        }
    }
}

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
    #[serde(default)]
    message: String,
}

fn default_expires_in() -> u64 {
    900
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XboxResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims", default)]
    display_claims: Option<DisplayClaims>,
}

#[derive(Debug, Deserialize)]
struct DisplayClaims {
    #[serde(default)]
    xui: Vec<XuiClaim>,
}

#[derive(Debug, Deserialize)]
struct XuiClaim {
    #[serde(default)]
    uhs: String,
    #[serde(default)]
    xid: String,
}

#[derive(Debug, Deserialize)]
struct XstsError {
    #[serde(rename = "XErr", default)]
    xerr: u64,
}

#[derive(Debug, Deserialize)]
struct ProfileResponse {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<ProfileSkin>,
}

#[derive(Debug, Deserialize)]
struct ProfileSkin {
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct EntitlementsResponse {
    #[serde(default)]
    items: Vec<EntitlementItem>,
}

#[derive(Debug, Deserialize)]
struct EntitlementItem {
    #[serde(default)]
    name: String,
}

/// XErr codes Microsoft returns from XSTS; the plain status code is useless to
/// a user, so each one gets an instruction they can act on.
pub fn xerr_message(code: u64) -> String {
    let detail = match code {
        2148916227 => "该微软账户已被 Xbox Live 封禁。",
        2148916229 => "该微软账户是未成年账户且未加入家庭组，请先在 Xbox 官网完成成人验证。",
        2148916233 => "该微软账户还没有 Xbox 账户，请先到 https://www.xbox.com 登录一次以创建。",
        2148916235 => "当前网络所在的国家/地区不支持 Xbox Live。",
        2148916236 | 2148916237 => "该账户需要成人验证后才能用于 Xbox Live。",
        2148916238 => "该账户是未成年账户，需要由家庭组中的成人添加后才能登录。",
        2148916250 => "该账户的 Xbox 档案已不再可用。",
        _ => "Xbox Live 拒绝了这个账户。",
    };
    format!("{detail}（XErr {code}）")
}

fn device_error_message(code: &str, description: Option<&str>, client_id: &str) -> String {
    match code {
        "authorization_declined" => "已取消登录授权。".to_string(),
        "expired_token" | "bad_verification_code" => "验证码已失效，请重新获取。".to_string(),
        "invalid_client" | "unauthorized_client" => format!(
            "微软不接受这个客户端 ID（{client_id}），请在设置里填入你自己注册的 Azure 应用 ID。"
        ),
        "invalid_grant" => "登录凭据已失效，请重新登录。".to_string(),
        other => {
            let hint = description.unwrap_or("").trim();
            if hint.is_empty() {
                format!("微软登录失败：{other}")
            } else {
                format!("微软登录失败：{hint}")
            }
        }
    }
}

async fn post_json(
    url: &str,
    body: &serde_json::Value,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let response = crate::net::client()
        .post(url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/json")
        .json(body)
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

async fn post_form(
    url: &str,
    form: &[(&str, &str)],
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let response = crate::net::client()
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

/// Step 1: ask Microsoft for a code the user types into their browser.
pub async fn begin_device_login(custom_client_id: Option<&str>) -> Result<DeviceCodeInfo, String> {
    let client_id = client_id_of(custom_client_id);
    let (status, value) = post_form(
        DEVICE_CODE_URL,
        &[("client_id", client_id.as_str()), ("scope", SCOPE)],
    )
    .await?;

    if !status.is_success() {
        let message = value
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("无法获取设备代码");
        return Err(format!(
            "微软未返回验证码（HTTP {status}）：{message}。可在设置里填写自己的 Azure 应用 ID。"
        ));
    }

    let parsed: DeviceCodeResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析微软返回的验证码: {error}"))?;

    Ok(DeviceCodeInfo {
        user_code: parsed.user_code,
        device_code: parsed.device_code,
        verification_uri: parsed.verification_uri,
        verification_uri_complete: parsed
            .verification_uri_complete
            .filter(|url| !url.is_empty()),
        expires_in: parsed.expires_in,
        interval: parsed.interval.max(1),
        message: if parsed.message.is_empty() {
            "请在弹出的页面输入下面的代码完成登录。".to_string()
        } else {
            parsed.message
        },
    })
}

/// Step 2: poll until the user finishes, then run the whole Xbox chain.
pub async fn poll_device_login(
    custom_client_id: Option<&str>,
    device_code: &str,
) -> Result<DeviceOutcome, String> {
    let client_id = client_id_of(custom_client_id);
    let (status, value) = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
            ("client_id", client_id.as_str()),
        ],
    )
    .await?;
    let parsed: TokenResponse =
        serde_json::from_value(value).map_err(|error| format!("无法解析微软登录响应: {error}"))?;

    if let Some(code) = parsed.error.as_deref() {
        return match code {
            "authorization_pending" => Ok(DeviceOutcome::Pending),
            "slow_down" => Ok(DeviceOutcome::SlowDown),
            other => Err(device_error_message(
                other,
                parsed.error_description.as_deref(),
                &client_id,
            )),
        };
    }

    if !status.is_success() {
        return Err(format!("微软登录失败（HTTP {status}）"));
    }

    let ms_access_token = parsed
        .access_token
        .ok_or_else(|| "微软没有返回访问令牌".to_string())?;
    let refresh_token = parsed
        .refresh_token
        .ok_or_else(|| "微软没有返回刷新令牌（缺少 offline_access 权限）".to_string())?;
    let expires_at = now_secs() + parsed.expires_in.unwrap_or(3600);

    let mut record = authorize_chain(&ms_access_token).await?;
    record.client_id = client_id;
    record.refresh_token = refresh_token;
    record.expires_at = expires_at;
    Ok(DeviceOutcome::Done(Box::new(record)))
}

/// Steps 3–6 for a fresh Microsoft access token.
pub async fn authorize_chain(ms_access_token: &str) -> Result<AccountRecord, String> {
    // 3. Xbox Live user authentication (RpsTicket carries the MS token).
    let (status, value) = post_json(
        XBL_URL,
        &serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={ms_access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }),
    )
    .await?;
    if !status.is_success() {
        return Err(format!(
            "Xbox Live 用户认证失败（HTTP {status}）：{}",
            error_text(&value)
        ));
    }
    let xbl: XboxResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析 Xbox 认证结果: {error}"))?;

    // 4. XSTS authorization, scoped to the Minecraft relying party.
    let (status, value) = post_json(
        XSTS_URL,
        &serde_json::json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl.token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }),
    )
    .await?;
    if status.as_u16() == 401 {
        let xerr = serde_json::from_value::<XstsError>(value.clone())
            .map(|error| error.xerr)
            .unwrap_or(0);
        if xerr != 0 {
            return Err(xerr_message(xerr));
        }
        return Err(
            "Xbox Live 拒绝了该账户，请确认账户可以在 https://www.xbox.com 正常登录。".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!(
            "XSTS 授权失败（HTTP {status}）：{}",
            error_text(&value)
        ));
    }
    let xsts: XboxResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析 XSTS 授权结果: {error}"))?;
    let claims = xsts
        .display_claims
        .as_ref()
        .and_then(|claims| claims.xui.first())
        .ok_or_else(|| "XSTS 没有返回用户声明".to_string())?;
    let uhs = claims.uhs.clone();
    if uhs.is_empty() {
        return Err("XSTS 没有返回用户哈希（uhs）".to_string());
    }
    let xuid = claims.xid.clone();

    // 5. Exchange the XSTS token for a Minecraft session token.
    let (status, value) = post_json(
        MC_LOGIN_URL,
        &serde_json::json!({
            "identityToken": format!("XBL3.0 x={uhs};{}", xsts.token)
        }),
    )
    .await?;
    if !status.is_success() {
        let reason = value
            .get("details")
            .and_then(|details| details.get("reason"))
            .and_then(|reason| reason.as_str())
            .unwrap_or("");
        return Err(match reason {
            "ACCOUNT_SUSPENDED" => "该账户已被 Minecraft 封禁，无法登录。".to_string(),
            _ => format!(
                "Minecraft 登录失败（HTTP {status}）：{}",
                error_text(&value)
            ),
        });
    }
    let session: TokenResponse = serde_json::from_value(value)
        .map_err(|error| format!("无法解析 Minecraft 会话: {error}"))?;
    let access_token = session
        .access_token
        .ok_or_else(|| "Minecraft 没有返回会话令牌".to_string())?;
    let session_expires_at = now_secs() + session.expires_in.unwrap_or(86_400);

    // 6. Profile (proves Java ownership) and licence (proves Bedrock).
    let profile = fetch_profile(&access_token).await?;
    let entitlements = fetch_entitlements(&access_token).await?;

    Ok(AccountRecord {
        client_id: DEFAULT_CLIENT_ID.to_string(),
        refresh_token: String::new(),
        expires_at: now_secs(),
        minecraft: MinecraftToken {
            access_token,
            expires_at: session_expires_at,
            xuid,
            uhs,
        },
        profile,
        entitlements,
        saved_at: now_secs(),
    })
}

fn error_text(value: &serde_json::Value) -> String {
    for key in ["errorMessage", "Message", "error_description", "error"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }
    "未知错误".to_string()
}

pub async fn fetch_profile(access_token: &str) -> Result<MsProfile, String> {
    let response = crate::net::client()
        .get(PROFILE_URL)
        .timeout(Duration::from_secs(20))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("读取 Minecraft 档案失败: {error}"))?;
    if response.status().as_u16() == 404 {
        return Err("该微软账户没有购买 Minecraft: Java 版（或尚未创建游戏档案）。".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "读取 Minecraft 档案失败（HTTP {}）",
            response.status()
        ));
    }
    let profile: ProfileResponse = response
        .json()
        .await
        .map_err(|error| format!("无法解析 Minecraft 档案: {error}"))?;
    let skin_url = profile
        .skins
        .iter()
        .find(|skin| skin.state.eq_ignore_ascii_case("ACTIVE"))
        .or_else(|| profile.skins.first())
        .map(|skin| skin.url.clone())
        .filter(|url| !url.is_empty());
    Ok(MsProfile {
        id: profile.id,
        name: profile.name,
        skin_url,
    })
}

/// The licence endpoint is what makes "one account, both editions" possible:
/// it reports Java and Bedrock ownership for the same Microsoft account.
pub async fn fetch_entitlements(access_token: &str) -> Result<Entitlements, String> {
    let url = format!("{ENTITLEMENTS_URL}?requestId={}", uuid_v4());
    let response = crate::net::client()
        .get(&url)
        .timeout(Duration::from_secs(20))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("读取游戏授权失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("读取游戏授权失败（HTTP {}）", response.status()));
    }
    let parsed: EntitlementsResponse = response
        .json()
        .await
        .map_err(|error| format!("无法解析游戏授权: {error}"))?;
    Ok(classify_entitlements(
        parsed.items.iter().map(|item| item.name.as_str()),
    ))
}

fn classify_entitlements<'a>(names: impl Iterator<Item = &'a str>) -> Entitlements {
    let items: Vec<String> = names
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    Entitlements {
        java: items.iter().any(|name| name == "product_minecraft"),
        bedrock: items
            .iter()
            .any(|name| name.starts_with("product_minecraft_bedrock")),
        game_pass: items.iter().any(|name| name.contains("game_pass")),
        items,
    }
}

/// Random request id — the licence endpoint rejects a reused one. `RandomState`
/// is seeded per instance by the standard library, which is enough entropy for
/// a request id without pulling in another dependency.
fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut bytes = [0u8; 16];
    for (half, slot) in bytes.chunks_mut(8).enumerate() {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(now_secs());
        hasher.write_u32(std::process::id());
        hasher.write_usize(half);
        slot.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let mut text = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// Mint a fresh session from the stored refresh token. Called before a launch
/// when the Java session has expired.
pub async fn refresh_account(record: &AccountRecord) -> Result<AccountRecord, String> {
    if record.refresh_token.is_empty() {
        return Err("没有可用的刷新令牌，请重新登录。".to_string());
    }
    let (status, value) = post_form(
        TOKEN_URL,
        &[
            ("client_id", record.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", record.refresh_token.as_str()),
            ("scope", SCOPE),
        ],
    )
    .await?;
    let parsed: TokenResponse =
        serde_json::from_value(value).map_err(|error| format!("无法解析刷新结果: {error}"))?;
    if let Some(code) = parsed.error.as_deref() {
        return Err(device_error_message(
            code,
            parsed.error_description.as_deref(),
            &record.client_id,
        ));
    }
    if !status.is_success() {
        return Err(format!("刷新登录状态失败（HTTP {status}）"));
    }

    let ms_access_token = parsed
        .access_token
        .ok_or_else(|| "刷新时微软没有返回访问令牌".to_string())?;
    let mut next = authorize_chain(&ms_access_token).await?;
    next.client_id = record.client_id.clone();
    next.refresh_token = parsed
        .refresh_token
        .unwrap_or_else(|| record.refresh_token.clone());
    next.expires_at = now_secs() + parsed.expires_in.unwrap_or(3600);
    Ok(next)
}

pub fn load_account(data_dir: &Path) -> Option<AccountRecord> {
    let path = account_path(data_dir);
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn store_account(data_dir: &Path, record: &AccountRecord) -> Result<(), String> {
    let path = account_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建账号目录: {error}"))?;
    }
    let json =
        serde_json::to_string_pretty(record).map_err(|error| format!("序列化账号失败: {error}"))?;
    std::fs::write(&path, json).map_err(|error| format!("无法保存账号: {error}"))?;
    restrict_permissions(&path);
    Ok(())
}

pub fn clear_account(data_dir: &Path) -> Result<(), String> {
    let path = account_path(data_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| format!("无法删除账号文件: {error}"))?;
    }
    Ok(())
}

/// The file holds a refresh token; keep it owner-only where the OS allows it.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// A launch-ready session: the stored one, or a freshly refreshed one. `None`
/// means the launch must fall back to the offline account.
///
/// The session token deliberately never travels through the UI — the launch
/// command reads it straight from this store.
pub async fn session_for_launch(data_dir: &Path) -> Option<AccountRecord> {
    let record = load_account(data_dir)?;
    if record.session_alive() {
        return Some(record);
    }
    match refresh_account(&record).await {
        Ok(next) => {
            let _ = store_account(data_dir, &next);
            Some(next)
        }
        Err(_) => None,
    }
}

/// The stored session, renewed when the Java token aged out. The view keeps
/// showing the identity even when renewal fails, so the user can see who is
/// signed in and retry from the UI instead of being silently signed out.
pub async fn account_view(data_dir: &Path, custom_client_id: Option<&str>) -> Option<AccountView> {
    let record = load_account(data_dir)?;
    let wanted = client_id_of(custom_client_id);
    if record.session_alive() {
        let mut view = record.view();
        view.client_id = wanted;
        return Some(view);
    }

    match refresh_account(&record).await {
        Ok(next) => {
            let _ = store_account(data_dir, &next);
            Some(next.view())
        }
        Err(error) => {
            let mut view = record.view();
            view.session_error = Some(error);
            Some(view)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record() -> AccountRecord {
        AccountRecord {
            client_id: DEFAULT_CLIENT_ID.to_string(),
            refresh_token: "refresh-token".to_string(),
            expires_at: now_secs() + 3600,
            minecraft: MinecraftToken {
                access_token: "mc-token".to_string(),
                expires_at: now_secs() + 86_400,
                xuid: "2535410000000000".to_string(),
                uhs: "uhs-value".to_string(),
            },
            profile: MsProfile {
                id: "069a79f444e94726a5befca90e38aaf5".to_string(),
                name: "Steve".to_string(),
                skin_url: Some("http://textures.minecraft.net/texture/abc".to_string()),
            },
            entitlements: Entitlements {
                java: true,
                bedrock: true,
                game_pass: false,
                items: vec![
                    "product_minecraft".into(),
                    "product_minecraft_bedrock".into(),
                ],
            },
            saved_at: now_secs(),
        }
    }

    #[test]
    fn default_client_id_is_a_launcher_client() {
        assert_eq!(DEFAULT_CLIENT_ID.len(), 36);
        assert!(DEFAULT_CLIENT_ID.contains('-'));
        // A missing or blank override must fall back to the built-in id.
        assert_eq!(client_id_of(None), DEFAULT_CLIENT_ID);
        assert_eq!(client_id_of(Some("   ")), DEFAULT_CLIENT_ID);
        assert_eq!(client_id_of(Some(" mine ")), "mine");
    }

    #[test]
    fn device_code_response_is_parsed_with_defaults() {
        let raw = r#"{
            "user_code": "ABCD-EFGH",
            "device_code": "device-code-value",
            "verification_uri": "https://microsoft.com/link",
            "expires_in": 900,
            "interval": 5,
            "message": "To sign in, use a web browser"
        }"#;
        let parsed: DeviceCodeResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.user_code, "ABCD-EFGH");
        assert_eq!(parsed.interval, 5);
        assert_eq!(parsed.device_code, "device-code-value");
        assert!(parsed.verification_uri_complete.is_none());

        // The prefilled link (`?otc=…`) is preferred when Microsoft sends one.
        let complete: DeviceCodeResponse = serde_json::from_str(
            r#"{"user_code":"X","device_code":"Y","verification_uri":"https://microsoft.com/link","verification_uri_complete":"https://microsoft.com/link?otc=X"}"#,
        )
        .unwrap();
        assert_eq!(
            complete.verification_uri_complete.as_deref(),
            Some("https://microsoft.com/link?otc=X")
        );

        // Older tenants omit interval/expires_in; polling must still work.
        let bare: DeviceCodeResponse =
            serde_json::from_str(r#"{"user_code":"X","device_code":"Y","verification_uri":"https://microsoft.com/link"}"#)
                .unwrap();
        assert_eq!(bare.interval, 5);
        assert_eq!(bare.expires_in, 900);
        assert!(bare.message.is_empty());
    }

    #[test]
    fn login_window_urls_are_restricted_to_microsoft_hosts() {
        // The device-code entry page and the account picker are both allowed.
        assert!(is_microsoft_login_url(
            "https://microsoft.com/link?otc=ABCD"
        ));
        assert!(is_microsoft_login_url(
            "https://login.live.com/oauth20_authorize.srf?x=1"
        ));
        assert!(is_microsoft_login_url(
            "https://login.microsoftonline.com/common/oauth2/deviceauth"
        ));

        // Everything else is refused: plain http, look-alike hosts, other sites.
        assert!(!is_microsoft_login_url("http://microsoft.com/link"));
        assert!(!is_microsoft_login_url(
            "https://microsoft.com.evil.example/link"
        ));
        assert!(!is_microsoft_login_url("https://notlive.com/link"));
        assert!(!is_microsoft_login_url("https://example.com/"));
        assert!(!is_microsoft_login_url("not a url"));
    }

    #[test]
    fn device_errors_become_actionable_messages() {
        assert!(device_error_message("authorization_declined", None, "id").contains("取消"));
        assert!(device_error_message("expired_token", None, "id").contains("失效"));
        let client = device_error_message("invalid_client", None, "my-client-id");
        assert!(client.contains("my-client-id"), "{client}");
        assert!(client.contains("Azure"), "{client}");
        let hint = device_error_message("temporarily_unavailable", Some("try later"), "id");
        assert!(hint.contains("try later"), "{hint}");
    }

    #[test]
    fn xerr_codes_explain_the_fix() {
        let no_xbox = xerr_message(2148916233);
        assert!(no_xbox.contains("Xbox 账户"), "{no_xbox}");
        assert!(no_xbox.contains("2148916233"), "{no_xbox}");
        assert!(xerr_message(2148916238).contains("未成年"));
        assert!(xerr_message(2148916235).contains("地区"));
        assert!(xerr_message(0).contains("Xbox Live"));
    }

    #[test]
    fn entitlements_separate_java_from_bedrock() {
        let both =
            classify_entitlements(["product_minecraft", "product_minecraft_bedrock"].into_iter());
        assert!(both.java && both.bedrock && !both.game_pass);

        // Game Pass grants both editions without an outright purchase.
        let pass = classify_entitlements(["product_game_pass_ultimate"].into_iter());
        assert!(pass.game_pass && !pass.java && !pass.bedrock);

        // Bedrock-only accounts exist: a Windows player who never bought Java.
        let bedrock_only = classify_entitlements(["PRODUCT_MINECRAFT_BEDROCK"].into_iter());
        assert!(bedrock_only.bedrock && !bedrock_only.java);

        let none = classify_entitlements(std::iter::empty());
        assert_eq!(none, Entitlements::default());
    }

    #[test]
    fn account_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("cobble-account-{}", uuid_v4()));
        let record = sample_record();
        assert!(load_account(&dir).is_none());
        store_account(&dir, &record).unwrap();

        let loaded = load_account(&dir).expect("stored account loads");
        assert_eq!(loaded.profile.name, "Steve");
        assert_eq!(loaded.minecraft.xuid, record.minecraft.xuid);
        assert!(loaded.entitlements.bedrock);
        assert!(loaded.session_alive());
        let view = loaded.view();
        assert!(view.signed_in);
        assert_eq!(view.uuid, record.profile.id);

        clear_account(&dir).unwrap();
        assert!(load_account(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_session_is_not_handed_to_the_game() {
        let mut record = sample_record();
        record.minecraft.expires_at = now_secs() - 10;
        assert!(!record.session_alive());
        // The slack window is what keeps a long download from producing a dead
        // session right at launch time.
        record.minecraft.expires_at = now_secs() + SESSION_SLACK_SECS - 1;
        assert!(!record.session_alive());
        record.minecraft.expires_at = now_secs() + SESSION_SLACK_SECS + 60;
        assert!(record.session_alive());
    }

    #[test]
    fn licence_request_ids_are_unique_and_well_formed() {
        let first = uuid_v4();
        let second = uuid_v4();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
        assert!(first
            .chars()
            .all(|value| value.is_ascii_hexdigit() || value == '-'));
        assert_eq!(first.matches('-').count(), 4);
        // Version nibble must be 4, variant must be RFC 4122.
        assert_eq!(&first[14..15], "4");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn xbox_claims_are_read_from_display_claims() {
        let raw = r#"{
            "Token": "xsts-token",
            "DisplayClaims": { "xui": [ { "uhs": "uhs-1", "xid": "2535" } ] }
        }"#;
        let parsed: XboxResponse = serde_json::from_str(raw).unwrap();
        let claims = parsed.display_claims.unwrap().xui;
        assert_eq!(claims[0].uhs, "uhs-1");
        assert_eq!(claims[0].xid, "2535");
    }

    #[test]
    fn xsts_error_payload_is_understood() {
        let parsed: XstsError =
            serde_json::from_str(r#"{"Identity":"0","XErr":2148916233,"Message":""}"#).unwrap();
        assert_eq!(parsed.xerr, 2148916233);
    }
}
