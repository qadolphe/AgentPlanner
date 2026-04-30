use crate::bridge::BridgeClient;
use crate::config::{
    ensure_workspace_gitignored, load_global_auth, load_workspace_link, normalize_base_url,
    save_global_auth, save_workspace_link, validate_uuid_like, workspace_link_path, GlobalAuth,
    ProjectScope, WorkspaceLink, DEFAULT_URL,
};
use crate::models::{AgentControls, Project, SyncResult};
use crate::resources::ResourceService;
use crate::sync::SyncService;
use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const API_KEY_ENV: &str = "PINKSUNDEW_API_KEY";
const CLIENT_ENV: &str = "PINKSUNDEW_CLIENT";
const PROJECT_ID_ENV: &str = "PINKSUNDEW_PROJECT_ID";
const DISTRIBUTION_CHANNEL_ENV: &str = "PINKSUNDEW_MCP_DISTRIBUTION_CHANNEL";
const NATIVE_MCP_COMMAND: &str = "pinksundew-mcp";

#[derive(Debug, Parser)]
#[command(
    name = "pinksundew-mcp",
    version,
    about = "Pink Sundew MCP server and setup CLI"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Interactive first-time setup
    Init(InitArgs),
    /// Complete web-to-CLI setup from a short-lived setup token
    Setup(SetupArgs),
    /// Register MCP config for a client without linking a workspace
    Register(RegisterArgs),
    /// Link the current directory to a Pink Sundew project
    Link(LinkArgs),
    /// Unlink the current directory from Pink Sundew
    Unlink,
    /// Show auth, registration, workspace link, and sync status
    Status,
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Skip write confirmation prompts
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Args)]
pub struct SetupArgs {
    /// Short-lived setup token from the Pink Sundew web app
    #[arg(long)]
    token: String,

    /// Client target to set up
    #[arg(long, value_enum)]
    client: Client,

    /// Project ID to link this workspace to
    #[arg(long)]
    project: String,

    /// Custom client config file path override
    #[arg(long)]
    file: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct RegisterArgs {
    /// Client target to register
    #[arg(value_enum)]
    client: Option<Client>,

    /// Custom config file path override
    #[arg(long)]
    file: Option<PathBuf>,

    /// Skip interactive confirmation prompt
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Args)]
pub struct LinkArgs {
    /// Project ID to link this workspace to
    #[arg(long)]
    project: String,
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    Cursor,
    Codex,
    ClaudeCode,
    Antigravity,
    Vscode,
    Windsurf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandTuple {
    command: String,
    args: Vec<String>,
}

#[derive(Debug)]
struct ResolvedRegisterConfig {
    client: Client,
    target_file: PathBuf,
    command_tuple: CommandTuple,
}

#[derive(Debug)]
struct RenderedConfig {
    preview: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct SetupExchangeRequest<'a> {
    token: &'a str,
    client: &'a str,
    #[serde(rename = "projectId")]
    project_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct SetupExchangeResponse {
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "keyPrefix")]
    key_prefix: String,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    project: SetupProject,
}

#[derive(Debug, Deserialize)]
struct SetupProject {
    id: String,
    name: String,
}

pub async fn execute(command: Command) -> Result<()> {
    match command {
        Command::Init(args) => init(args).await,
        Command::Setup(args) => setup(args).await,
        Command::Register(args) => register(args).await,
        Command::Link(args) => link(args).await,
        Command::Unlink => unlink(),
        Command::Status => status().await,
    }
}

async fn init(args: InitArgs) -> Result<()> {
    ensure_interactive("init")?;
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;

    let api_key = prompt_secret("Paste API key: ")?;
    let base_url = env_base_url();
    let auth = GlobalAuth::new(api_key, base_url);
    save_global_auth(&auth)?;
    eprintln!("[pinksundew-mcp] Saved global auth ({})", auth.key_prefix);

    let clients = prompt_clients()?;
    for client in &clients {
        register_client(*client, None, true)?;
    }

    let bridge = BridgeClient::new(auth.base_url.clone(), auth.api_key.clone());
    let project = prompt_project(&bridge).await?;
    write_workspace_link_and_ignore(&cwd, &project)?;

    for client in &clients {
        enable_sync_target(&bridge, project.id.as_str(), *client).await?;
    }

    let sync_result = sync_workspace(&auth, &cwd).await?;
    print_success_summary(&clients, &project, &sync_result);
    let _ = args.yes;
    Ok(())
}

async fn setup(args: SetupArgs) -> Result<()> {
    validate_uuid_like(args.project.as_str())?;
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;
    let base_url = env_base_url();
    let exchange = exchange_setup_token(
        base_url.as_str(),
        args.token.as_str(),
        args.client,
        args.project.as_str(),
    )
    .await?;

    let mut auth = GlobalAuth::new(
        exchange.api_key,
        exchange.base_url.unwrap_or_else(|| base_url.clone()),
    );
    auth.key_prefix = exchange.key_prefix;
    save_global_auth(&auth)?;

    register_client(args.client, args.file, true)?;

    let project = Project {
        id: exchange.project.id,
        name: exchange.project.name,
        description: None,
        created_by: None,
        created_at: None,
        updated_at: None,
        role: None,
    };
    write_workspace_link_and_ignore(&cwd, &project)?;

    let bridge = BridgeClient::new(auth.base_url.clone(), auth.api_key.clone());
    enable_sync_target(&bridge, project.id.as_str(), args.client).await?;
    let sync_result = sync_workspace(&auth, &cwd).await?;

    eprintln!();
    eprintln!("✅ Client:  {}", client_label_title(args.client));
    eprintln!("🔗 Linked:  {} ({})", project.name.as_str(), project.id);
    eprintln!(
        "📁 Synced:  {}",
        if sync_result.files_written.is_empty() {
            "none".to_string()
        } else {
            sync_result.files_written.join(", ")
        }
    );
    eprintln!();
    eprintln!(
        "Ready! Open {} and ask it to view your tasks.",
        client_label_title(args.client)
    );

    Ok(())
}

async fn register(args: RegisterArgs) -> Result<()> {
    let client = match args.client {
        Some(client) => client,
        None => {
            ensure_interactive("register without a client")?;
            prompt_single_client()?
        }
    };

    let _auth = load_global_auth_or_prompt()?;
    register_client(client, args.file, args.yes)
}

async fn link(args: LinkArgs) -> Result<()> {
    validate_uuid_like(args.project.as_str())?;
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;
    let auth = load_global_auth().map_err(|e| {
        anyhow!(
            "{e}\n\nFor first-time setup, run `pinksundew-mcp init` or use the web setup command."
        )
    })?;
    let bridge = BridgeClient::new(auth.base_url.clone(), auth.api_key.clone());
    let projects = bridge.get_json::<Vec<Project>>("/projects").await?;
    let project = projects
        .into_iter()
        .find(|project| project.id == args.project)
        .ok_or_else(|| {
            anyhow!(
                "Project {} was not found or is not accessible",
                args.project
            )
        })?;

    write_workspace_link_and_ignore(&cwd, &project)?;
    let sync_result = sync_workspace(&auth, &cwd).await?;

    eprintln!();
    eprintln!("🔗 Linked:  {} ({})", project.name.as_str(), project.id);
    eprintln!(
        "📁 Synced:  {}",
        if sync_result.files_written.is_empty() {
            "none".to_string()
        } else {
            sync_result.files_written.join(", ")
        }
    );
    eprintln!();
    Ok(())
}

fn unlink() -> Result<()> {
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;
    if crate::config::delete_workspace_link(&cwd)? {
        eprintln!(
            "[pinksundew-mcp] Deleted {}",
            workspace_link_path(&cwd).display()
        );
    } else {
        eprintln!("[pinksundew-mcp] No workspace link found.");
    }
    Ok(())
}

async fn status() -> Result<()> {
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;

    match load_global_auth() {
        Ok(auth) => {
            eprintln!("auth configured: yes");
            eprintln!("key prefix: {}", auth.key_prefix);
            eprintln!("base url: {}", auth.base_url);
        }
        Err(_) => {
            eprintln!("auth configured: no");
        }
    }

    eprintln!("registered clients:");
    eprintln!(
        "  Codex: {}",
        yes_no(is_registered(Client::Codex, &cwd).unwrap_or(false))
    );
    eprintln!(
        "  Cursor: {}",
        yes_no(is_registered(Client::Cursor, &cwd).unwrap_or(false))
    );
    eprintln!(
        "  VS Code: {}",
        yes_no(is_registered(Client::Vscode, &cwd).unwrap_or(false))
    );
    eprintln!(
        "  Windsurf: {}",
        yes_no(is_registered(Client::Windsurf, &cwd).unwrap_or(false))
    );
    let mcp_json_registered = is_project_mcp_json_registered(&cwd).unwrap_or(false);
    eprintln!("  Claude Code: {}", yes_no(mcp_json_registered));
    eprintln!("  Antigravity: {}", yes_no(mcp_json_registered));

    match load_workspace_link(&cwd) {
        Ok(link) => {
            eprintln!("workspace linked: yes");
            eprintln!(
                "linked project: {} ({})",
                link.project_name, link.project_id
            );
            eprintln!(
                "last sync: {}",
                link.last_synced_at.as_deref().unwrap_or("never")
            );
            eprintln!(
                "last instruction hash: {}",
                link.last_instruction_hash.as_deref().unwrap_or("unknown")
            );

            if let Ok(auth) = load_global_auth() {
                let bridge = BridgeClient::new(auth.base_url, auth.api_key);
                match bridge
                    .get_json::<AgentControls>(&format!("/controls/{}", link.project_id))
                    .await
                {
                    Ok(controls) => {
                        let targets = enabled_sync_targets(&controls);
                        eprintln!(
                            "enabled sync targets: {}",
                            if targets.is_empty() {
                                "none".to_string()
                            } else {
                                targets.join(", ")
                            }
                        );
                    }
                    Err(err) => {
                        eprintln!("enabled sync targets: unavailable ({err})");
                    }
                }
            }
        }
        Err(_) => {
            eprintln!("workspace linked: no");
        }
    }

    Ok(())
}

fn register_client(client: Client, file: Option<PathBuf>, auto_yes: bool) -> Result<()> {
    let cwd = std::env::current_dir().context("Unable to resolve current directory")?;
    let resolved = resolve_register_config(client, file, &cwd)?;

    let existing = if resolved.target_file.exists() {
        Some(
            fs::read_to_string(&resolved.target_file)
                .with_context(|| format!("Failed to read {}", resolved.target_file.display()))?,
        )
    } else {
        None
    };

    let rendered = render_config(&resolved, existing.as_deref())?;

    eprintln!(
        "[pinksundew-mcp] Register target ({}) -> {}",
        client_label(resolved.client),
        resolved.target_file.display()
    );
    eprintln!("[pinksundew-mcp] Planned MCP block:");
    eprintln!("{}", rendered.preview);

    confirm_write(&resolved.target_file, resolved.client, auto_yes)?;

    let backup_path = backup_existing_file(&resolved.target_file)?;
    if let Some(path) = backup_path {
        eprintln!("[pinksundew-mcp] Backup created at {}", path.display());
    }

    write_atomic(&resolved.target_file, rendered.content.as_bytes())?;
    eprintln!(
        "[pinksundew-mcp] Wrote {} configuration to {}",
        client_label(resolved.client),
        resolved.target_file.display()
    );

    Ok(())
}

fn resolve_register_config(
    client: Client,
    explicit_file: Option<PathBuf>,
    cwd: &Path,
) -> Result<ResolvedRegisterConfig> {
    let target_file = resolve_target_file(client, explicit_file, cwd)?;
    let command_tuple = resolve_command_tuple()?;

    Ok(ResolvedRegisterConfig {
        client,
        target_file,
        command_tuple,
    })
}

fn resolve_target_file(
    client: Client,
    explicit_file: Option<PathBuf>,
    cwd: &Path,
) -> Result<PathBuf> {
    if let Some(path) = explicit_file {
        return Ok(path);
    }

    match client {
        Client::Codex => resolve_codex_config_path(),
        Client::Cursor => Ok(cwd.join(".cursor").join("mcp.json")),
        Client::Vscode => Ok(cwd.join(".vscode").join("mcp.json")),
        Client::Windsurf => resolve_windsurf_config_path(),
        Client::ClaudeCode | Client::Antigravity => Ok(cwd.join(".mcp.json")),
    }
}

fn resolve_codex_config_path() -> Result<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join("config.toml"));
        }
    }

    if let Some(home) = dirs::home_dir() {
        return Ok(home.join(".codex").join("config.toml"));
    }

    bail!("Unable to determine codex config location. Provide --file explicitly.")
}

fn resolve_windsurf_config_path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow!("Unable to determine Windsurf config location. Provide --file explicitly."))?;

    Ok(home.join(".codeium").join("windsurf").join("mcp_config.json"))
}

fn resolve_command_tuple() -> Result<CommandTuple> {
    let channel = std::env::var(DISTRIBUTION_CHANNEL_ENV)
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    if let Some(tuple) = command_tuple_for_known_channel(channel.as_str()) {
        if channel == "npm-wrapper" {
            eprintln!(
                "[pinksundew-mcp] DEPRECATED: npm wrapper channel is deprecated. Registering native command. Install with: brew install pinksundew/tap/pinksundew-mcp"
            );
        }
        return Ok(tuple);
    }

    if let Some(command) = find_command_on_path(NATIVE_MCP_COMMAND) {
        return Ok(CommandTuple {
            command,
            args: Vec::new(),
        });
    }

    let exe = std::env::current_exe().context("Unable to resolve current executable path")?;
    Ok(CommandTuple {
        command: exe.to_string_lossy().to_string(),
        args: Vec::new(),
    })
}

fn command_tuple_for_known_channel(channel: &str) -> Option<CommandTuple> {
    match channel {
        "npm-wrapper" => Some(CommandTuple {
            command: NATIVE_MCP_COMMAND.to_string(),
            args: Vec::new(),
        }),
        _ => None,
    }
}

fn find_command_on_path(command: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    find_command_in_paths(command, std::env::split_paths(&path_var))
}

fn find_command_in_paths<I>(command: &str, paths: I) -> Option<String>
where
    I: IntoIterator<Item = PathBuf>,
{
    paths.into_iter().find_map(|path| {
        let candidate = path.join(command);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }

        #[cfg(windows)]
        {
            let pathext = std::env::var_os("PATHEXT")
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| ".EXE;.BAT;.CMD;.COM".to_string());

            return pathext.split(';').find_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    return None;
                }
                let candidate = path.join(format!("{command}{extension}"));
                candidate
                    .is_file()
                    .then(|| candidate.to_string_lossy().to_string())
            });
        }

        #[cfg(not(windows))]
        {
            None
        }
    })
}

fn render_config(
    config: &ResolvedRegisterConfig,
    existing: Option<&str>,
) -> Result<RenderedConfig> {
    match config.client {
        Client::Codex => render_codex_config(config, existing),
        Client::Vscode => render_vscode_config(config, existing),
        Client::Cursor | Client::ClaudeCode | Client::Antigravity | Client::Windsurf => {
            render_mcp_json_config(config, existing)
        }
    }
}

fn render_codex_config(
    config: &ResolvedRegisterConfig,
    existing: Option<&str>,
) -> Result<RenderedConfig> {
    let mut doc = match existing {
        Some(raw) if !raw.trim().is_empty() => raw
            .parse::<DocumentMut>()
            .context("Failed to parse existing codex TOML config")?,
        _ => DocumentMut::new(),
    };

    if !doc.as_table().contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    } else if !doc["mcp_servers"].is_table_like() {
        bail!("Existing `mcp_servers` entry in codex config is not a table.");
    }

    let mcp_servers = doc["mcp_servers"]
        .as_table_like_mut()
        .ok_or_else(|| anyhow!("`mcp_servers` could not be treated as a table"))?;
    if let Some(existing) = mcp_servers.get("pinksundew") {
        if !existing.is_table_like() {
            bail!("Existing `mcp_servers.pinksundew` entry is not a table.");
        }
    } else {
        mcp_servers.insert("pinksundew", Item::Table(Table::new()));
    }

    let pinksundew = mcp_servers
        .get_mut("pinksundew")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| anyhow!("`mcp_servers.pinksundew` could not be treated as a table"))?;
    pinksundew.insert("command", value(config.command_tuple.command.clone()));
    pinksundew.insert("args", value(args_array(&config.command_tuple.args)));
    if !pinksundew.contains_key("env") {
        pinksundew.insert("env", Item::Table(Table::new()));
    }
    let env = pinksundew
        .get_mut("env")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| anyhow!("`mcp_servers.pinksundew.env` could not be treated as a table"))?;
    env.remove(API_KEY_ENV);
    env.remove(PROJECT_ID_ENV);
    env.insert(CLIENT_ENV, value(client_slug(config.client)));

    let preview = format!(
        "[mcp_servers.pinksundew]\ncommand = {}\nargs = {:?}",
        quote_toml_string(&config.command_tuple.command),
        config.command_tuple.args
    );
    let content = doc.to_string();

    Ok(RenderedConfig { preview, content })
}

fn render_mcp_json_config(
    config: &ResolvedRegisterConfig,
    existing: Option<&str>,
) -> Result<RenderedConfig> {
    let mut root_value = parse_json_root(existing, ".mcp.json")?;
    let root = root_value
        .as_object_mut()
        .ok_or_else(|| anyhow!("Existing MCP config root must be a JSON object"))?;

    let mcp_servers_item = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let mcp_servers = mcp_servers_item
        .as_object_mut()
        .ok_or_else(|| anyhow!("Existing `mcpServers` entry must be an object"))?;

    let server_object = build_stdio_server_object(config, matches!(config.client, Client::Cursor));
    mcp_servers.insert("pinksundew".to_string(), server_object.clone());

    let preview =
        serde_json::to_string_pretty(&server_object).context("Failed to render JSON preview")?;
    let content =
        serde_json::to_string_pretty(&root_value).context("Failed to render merged JSON")?;

    Ok(RenderedConfig { preview, content })
}

fn render_vscode_config(
    config: &ResolvedRegisterConfig,
    existing: Option<&str>,
) -> Result<RenderedConfig> {
    let mut root_value = parse_json_root(existing, ".vscode/mcp.json")?;
    let root = root_value
        .as_object_mut()
        .ok_or_else(|| anyhow!("Existing VS Code MCP config root must be a JSON object"))?;

    let servers_item = root
        .entry("servers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers_item
        .as_object_mut()
        .ok_or_else(|| anyhow!("Existing `servers` entry must be an object"))?;

    let server_object = build_stdio_server_object(config, false);
    servers.insert("pinksundew".to_string(), server_object.clone());

    let preview =
        serde_json::to_string_pretty(&server_object).context("Failed to render JSON preview")?;
    let content =
        serde_json::to_string_pretty(&root_value).context("Failed to render merged JSON")?;

    Ok(RenderedConfig { preview, content })
}

fn parse_json_root(existing: Option<&str>, label: &str) -> Result<Value> {
    let value = match existing {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<Value>(raw)
            .with_context(|| format!("Failed to parse existing {label}"))?,
        _ => Value::Object(Map::new()),
    };
    Ok(value)
}

fn build_stdio_server_object(
    config: &ResolvedRegisterConfig,
    include_workspace_cwd: bool,
) -> Value {
    let mut object = Map::new();
    object.insert("type".to_string(), Value::String("stdio".to_string()));
    object.insert(
        "command".to_string(),
        Value::String(config.command_tuple.command.clone()),
    );
    object.insert(
        "args".to_string(),
        Value::Array(
            config
                .command_tuple
                .args
                .iter()
                .map(|arg| Value::String(arg.clone()))
                .collect(),
        ),
    );
    if include_workspace_cwd {
        object.insert(
            "cwd".to_string(),
            Value::String("${workspaceFolder}".to_string()),
        );
    }
    let mut env = Map::new();
    env.insert(
        CLIENT_ENV.to_string(),
        Value::String(client_slug(config.client).to_string()),
    );
    object.insert("env".to_string(), Value::Object(env));
    Value::Object(object)
}

fn args_array(args: &[String]) -> Array {
    let mut args_array = Array::new();
    for arg in args {
        args_array.push(arg.as_str());
    }
    args_array
}

fn quote_toml_string(value: &str) -> String {
    format!("{value:?}")
}

fn confirm_write(target_file: &Path, client: Client, yes: bool) -> Result<()> {
    if yes {
        return Ok(());
    }

    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        bail!(
            "Refusing to update {} config at {} in non-interactive mode without --yes.",
            client_label(client),
            target_file.display()
        );
    }

    eprint!(
        "[pinksundew-mcp] Apply changes to {}? [Y/n]: ",
        target_file.display()
    );
    io::stderr().flush().ok();

    let mut response = String::new();
    io::stdin()
        .read_line(&mut response)
        .context("Failed to read prompt response")?;

    if !is_confirmation_accepted(&response) {
        bail!("Registration cancelled by user.");
    }

    Ok(())
}

fn is_confirmation_accepted(input: &str) -> bool {
    let normalized = input.trim().to_lowercase();
    normalized.is_empty() || normalized == "y" || normalized == "yes"
}

fn backup_existing_file(path: &Path) -> Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }

    let backup_root = std::env::temp_dir().join("pinksundew-mcp-backups");
    fs::create_dir_all(&backup_root).with_context(|| {
        format!(
            "Failed to create backup directory {}",
            backup_root.display()
        )
    })?;

    let base_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S%3f");
    let backup_path = backup_root.join(format!("{base_name}.bak.{timestamp}"));

    fs::copy(path, &backup_path).with_context(|| {
        format!(
            "Failed to backup {} to {}",
            path.display(),
            backup_path.display()
        )
    })?;

    Ok(Some(backup_path))
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("Failed to create directory {}", parent.display()))?;

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let temp_name = format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| chrono::Utc::now().timestamp_micros() * 1000)
    );
    let temp_path = parent.join(temp_name);

    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .with_context(|| format!("Failed to create temp file {}", temp_path.display()))?;
        file.write_all(content)
            .with_context(|| format!("Failed to write {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("Failed to sync {}", temp_path.display()))?;
    }

    if path.exists() {
        fs::remove_file(path).with_context(|| format!("Failed to replace {}", path.display()))?;
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error).with_context(|| {
            format!(
                "Failed to atomically move {} to {}",
                temp_path.display(),
                path.display()
            )
        });
    }

    Ok(())
}

fn load_global_auth_or_prompt() -> Result<GlobalAuth> {
    match load_global_auth() {
        Ok(auth) => Ok(auth),
        Err(_) => {
            ensure_interactive("register without saved auth")?;
            let api_key = prompt_secret("Paste API key: ")?;
            let auth = GlobalAuth::new(api_key, env_base_url());
            save_global_auth(&auth)?;
            eprintln!("[pinksundew-mcp] Saved global auth ({})", auth.key_prefix);
            Ok(auth)
        }
    }
}

fn env_base_url() -> String {
    std::env::var("PINKSUNDEW_URL")
        .ok()
        .map(|value| normalize_base_url(value.as_str()))
        .unwrap_or_else(|| DEFAULT_URL.to_string())
}

fn ensure_interactive(action: &str) -> Result<()> {
    if io::stdin().is_terminal() && io::stderr().is_terminal() {
        return Ok(());
    }
    bail!("Cannot run {action} interactively because stdin/stderr are not terminals.")
}

fn prompt_secret(prompt: &str) -> Result<String> {
    eprint!("{prompt}");
    io::stderr().flush().ok();

    #[cfg(unix)]
    let _echo_guard = EchoGuard::disable();

    let mut value = String::new();
    io::stdin()
        .read_line(&mut value)
        .context("Failed to read prompt response")?;

    #[cfg(unix)]
    eprintln!();

    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        bail!("API key cannot be empty.");
    }
    if !trimmed.starts_with("ap_") {
        bail!("API key must start with ap_.");
    }
    Ok(trimmed)
}

#[cfg(unix)]
struct EchoGuard;

#[cfg(unix)]
impl EchoGuard {
    fn disable() -> Self {
        let _ = std::process::Command::new("stty").arg("-echo").status();
        Self
    }
}

#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("stty").arg("echo").status();
    }
}

fn prompt_clients() -> Result<Vec<Client>> {
    let clients = [
        Client::Cursor,
        Client::Codex,
        Client::ClaudeCode,
        Client::Antigravity,
        Client::Vscode,
        Client::Windsurf,
    ];
    eprintln!("Which client(s) do you want to set up?");
    for (index, client) in clients.iter().enumerate() {
        eprintln!("  {}. {}", index + 1, client_label_title(*client));
    }
    eprint!("Choose one or more numbers, comma-separated: ");
    io::stderr().flush().ok();

    let mut response = String::new();
    io::stdin()
        .read_line(&mut response)
        .context("Failed to read prompt response")?;

    let mut selected = Vec::new();
    for part in response
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let index: usize = part
            .parse()
            .with_context(|| format!("Invalid client choice: {part}"))?;
        let client = clients
            .get(index.saturating_sub(1))
            .copied()
            .ok_or_else(|| anyhow!("Invalid client choice: {part}"))?;
        if !selected.contains(&client) {
            selected.push(client);
        }
    }

    if selected.is_empty() {
        bail!("At least one client must be selected.");
    }

    Ok(selected)
}

fn prompt_single_client() -> Result<Client> {
    let clients = prompt_clients()?;
    clients
        .first()
        .copied()
        .ok_or_else(|| anyhow!("No client selected"))
}

async fn prompt_project(bridge: &BridgeClient) -> Result<Project> {
    let projects = bridge.get_json::<Vec<Project>>("/projects").await?;
    if projects.is_empty() {
        bail!("No Pink Sundew projects were found for this API key.");
    }

    eprintln!("Which project should this directory use?");
    for (index, project) in projects.iter().enumerate() {
        eprintln!("  {}. {} ({})", index + 1, project.name, project.id);
    }
    eprint!("Choose a project number: ");
    io::stderr().flush().ok();

    let mut response = String::new();
    io::stdin()
        .read_line(&mut response)
        .context("Failed to read prompt response")?;
    let index: usize = response
        .trim()
        .parse()
        .with_context(|| format!("Invalid project choice: {}", response.trim()))?;

    projects
        .get(index.saturating_sub(1))
        .cloned()
        .ok_or_else(|| anyhow!("Invalid project choice: {}", response.trim()))
}

fn write_workspace_link_and_ignore(cwd: &Path, project: &Project) -> Result<()> {
    let link = WorkspaceLink::new(project.id.clone(), project.name.clone());
    save_workspace_link(cwd, &link)?;
    let _ = ensure_workspace_gitignored(cwd)?;
    Ok(())
}

async fn exchange_setup_token(
    base_url: &str,
    token: &str,
    client: Client,
    project_id: &str,
) -> Result<SetupExchangeResponse> {
    let url = format!("{}/api/setup-tokens/exchange", normalize_base_url(base_url));
    let body = SetupExchangeRequest {
        token,
        client: client_slug(client),
        project_id,
    };

    let response = reqwest::Client::new()
        .post(url.as_str())
        .json(&body)
        .send()
        .await
        .with_context(|| format!("Failed to exchange setup token with {url}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable body>".to_string());
        bail!("Setup token exchange failed {}: {}", status.as_u16(), body);
    }

    response
        .json::<SetupExchangeResponse>()
        .await
        .context("Failed to decode setup token exchange response")
}

async fn enable_sync_target(bridge: &BridgeClient, project_id: &str, client: Client) -> Result<()> {
    let sync_target = sync_target_for_client(client);
    bridge
        .patch_json::<Value, AgentControls>(
            &format!("/controls/{project_id}"),
            &json!({ "syncTarget": sync_target }),
        )
        .await?;
    eprintln!(
        "[pinksundew-mcp] Enabled {} instruction sync target for project.",
        client_label_title(client)
    );
    Ok(())
}

async fn sync_workspace(auth: &GlobalAuth, cwd: &Path) -> Result<SyncResult> {
    let scope = ProjectScope::from_workspace(cwd)?;
    let bridge = BridgeClient::new(auth.base_url.clone(), auth.api_key.clone());
    let resources = ResourceService::new(bridge, scope.clone());
    let sync = SyncService::new(resources, scope);
    let result = sync
        .sync_global_instructions(Some(cwd.to_path_buf()), true)
        .await;

    if result.success {
        Ok(result)
    } else {
        Err(anyhow!(
            "{}",
            result
                .error
                .unwrap_or_else(|| "Failed to sync instructions".to_string())
        ))
    }
}

fn print_success_summary(clients: &[Client], project: &Project, sync_result: &SyncResult) {
    let connected = clients
        .iter()
        .map(|client| client_label_title(*client))
        .collect::<Vec<_>>()
        .join(", ");
    eprintln!();
    eprintln!("✅ Client:  {connected}");
    eprintln!("🔗 Linked:  {} ({})", project.name.as_str(), project.id);
    eprintln!(
        "📁 Synced:  {}",
        if sync_result.files_written.is_empty() {
            "none".to_string()
        } else {
            sync_result.files_written.join(", ")
        }
    );
    eprintln!();
    eprintln!("Ready! Open your IDE or agent and ask it to view your tasks.");
}

fn enabled_sync_targets(controls: &AgentControls) -> Vec<String> {
    [
        ("sync_target_cursor", "Cursor"),
        ("sync_target_codex", "Codex"),
        ("sync_target_claude", "Claude Code"),
        ("sync_target_vscode", "VS Code"),
        ("sync_target_antigravity", "Antigravity"),
        ("sync_target_windsurf", "Windsurf"),
    ]
    .into_iter()
    .filter(|&(toggle, _label)| controls.tool_toggles.get(toggle).copied().unwrap_or(false))
    .map(|(_toggle, label)| label.to_string())
    .collect()
}

fn is_registered(client: Client, cwd: &Path) -> Result<bool> {
    match client {
        Client::Codex => config_contains(resolve_codex_config_path()?, "pinksundew"),
        Client::Cursor => config_contains(cwd.join(".cursor").join("mcp.json"), "pinksundew"),
        Client::Vscode => config_contains(cwd.join(".vscode").join("mcp.json"), "pinksundew"),
        Client::Windsurf => config_contains(resolve_windsurf_config_path()?, "pinksundew"),
        Client::ClaudeCode | Client::Antigravity => is_project_mcp_json_registered(cwd),
    }
}

fn is_project_mcp_json_registered(cwd: &Path) -> Result<bool> {
    config_contains(cwd.join(".mcp.json"), "pinksundew")
}

fn config_contains(path: PathBuf, needle: &str) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut content = String::new();
    fs::File::open(&path)
        .and_then(|mut file| file.read_to_string(&mut content))
        .with_context(|| format!("Failed to read {}", path.display()))?;
    Ok(content.contains(needle))
}

fn sync_target_for_client(client: Client) -> &'static str {
    match client {
        Client::Cursor => "sync_target_cursor",
        Client::Codex => "sync_target_codex",
        Client::ClaudeCode => "sync_target_claude",
        Client::Antigravity => "sync_target_antigravity",
        Client::Vscode => "sync_target_vscode",
        Client::Windsurf => "sync_target_windsurf",
    }
}

fn client_slug(client: Client) -> &'static str {
    match client {
        Client::Cursor => "cursor",
        Client::Codex => "codex",
        Client::ClaudeCode => "claude-code",
        Client::Antigravity => "antigravity",
        Client::Vscode => "vscode",
        Client::Windsurf => "windsurf",
    }
}

fn client_label(client: Client) -> &'static str {
    client_slug(client)
}

fn client_label_title(client: Client) -> &'static str {
    match client {
        Client::Cursor => "Cursor",
        Client::Codex => "Codex",
        Client::ClaudeCode => "Claude Code",
        Client::Antigravity => "Antigravity",
        Client::Vscode => "VS Code",
        Client::Windsurf => "Windsurf",
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn cli_parses_new_subcommands() {
        let parsed = Cli::try_parse_from(["pinksundew-mcp", "register", "codex"])
            .expect("parse should work");
        match parsed.command.expect("command expected") {
            Command::Register(args) => assert_eq!(args.client, Some(Client::Codex)),
            _ => panic!("wrong command"),
        }

        let parsed = Cli::try_parse_from([
            "pinksundew-mcp",
            "setup",
            "--token",
            "pst_abc",
            "--client",
            "claude-code",
            "--project",
            "8cd4fe92-63ad-49af-ae3a-c404f4576cc7",
        ])
        .expect("parse should work");
        match parsed.command.expect("command expected") {
            Command::Setup(args) => assert_eq!(args.client, Client::ClaudeCode),
            _ => panic!("wrong command"),
        }
    }

    #[test]
    fn codex_render_removes_secret_env_entries() {
        let existing = r#"# keep this comment
[mcp_servers.pinksundew]
command = "old"
args = []

[mcp_servers.pinksundew.env]
PINKSUNDEW_API_KEY = "ap_secret"
PINKSUNDEW_PROJECT_ID = "8cd4fe92-63ad-49af-ae3a-c404f4576cc7"
"#;

        let config = ResolvedRegisterConfig {
            client: Client::Codex,
            target_file: PathBuf::from("/tmp/config.toml"),
            command_tuple: CommandTuple {
                command: "pinksundew-mcp".to_string(),
                args: Vec::new(),
            },
        };

        let rendered = render_codex_config(&config, Some(existing)).expect("render should work");
        assert!(rendered.content.contains("# keep this comment"));
        assert!(rendered.content.contains("[mcp_servers.pinksundew]"));
        assert!(!rendered.content.contains(API_KEY_ENV));
        assert!(!rendered.content.contains(PROJECT_ID_ENV));
        assert!(rendered.content.contains(CLIENT_ENV));
    }

    #[test]
    fn mcp_json_render_sets_client_env_only() {
        let config = ResolvedRegisterConfig {
            client: Client::Antigravity,
            target_file: PathBuf::from(".mcp.json"),
            command_tuple: CommandTuple {
                command: "pinksundew-mcp".to_string(),
                args: Vec::new(),
            },
        };

        let rendered = render_mcp_json_config(&config, None).expect("render should work");
        let root: Value = serde_json::from_str(&rendered.content).expect("valid json");
        let server = root
            .pointer("/mcpServers/pinksundew")
            .and_then(Value::as_object)
            .expect("server object");
        let env = server
            .get("env")
            .and_then(Value::as_object)
            .expect("env object");
        assert_eq!(
            env.get(CLIENT_ENV).and_then(Value::as_str),
            Some(client_slug(config.client))
        );
        assert!(!env.contains_key(API_KEY_ENV));
        assert!(!env.contains_key(PROJECT_ID_ENV));
    }

    #[test]
    fn vscode_render_uses_servers_root() {
        let config = ResolvedRegisterConfig {
            client: Client::Vscode,
            target_file: PathBuf::from(".vscode/mcp.json"),
            command_tuple: CommandTuple {
                command: "pinksundew-mcp".to_string(),
                args: Vec::new(),
            },
        };

        let rendered = render_vscode_config(&config, None).expect("render should work");
        let root: Value = serde_json::from_str(&rendered.content).expect("valid json");
        assert!(root.pointer("/servers/pinksundew").is_some());
    }

    #[test]
    fn confirmation_parser_accepts_expected_values() {
        assert!(is_confirmation_accepted(""));
        assert!(is_confirmation_accepted("y"));
        assert!(is_confirmation_accepted("Yes"));
        assert!(!is_confirmation_accepted("n"));
    }

    #[test]
    fn known_channel_npm_wrapper_maps_to_native_binary() {
        let tuple = command_tuple_for_known_channel("npm-wrapper")
            .expect("npm-wrapper channel should be handled");
        assert_eq!(
            tuple,
            CommandTuple {
                command: NATIVE_MCP_COMMAND.to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn command_lookup_returns_stable_path_without_canonicalizing_symlinks() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let command_path = temp_dir.path().join(NATIVE_MCP_COMMAND);
        fs::write(&command_path, "").expect("write fake command");

        let resolved = find_command_in_paths(NATIVE_MCP_COMMAND, [temp_dir.path().to_path_buf()]);

        assert_eq!(resolved, Some(command_path.to_string_lossy().to_string()));
    }
}
